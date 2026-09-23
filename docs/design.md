# Gmail auto-labeling: design

Automatically add labels to incoming Gmail messages using
[Jev](https://docs.typesafe.ai/introduction) (TypeSafe's System One model) as
the classifier.

## Scope

- One personal `gmail.com` account.
- New messages only. No backfill of existing mail.
- Labels are only ever added. Existing labels, including ones a human set, are
  never removed or changed.
- No web interface. Labels, prompts, and thresholds live in a JSON config file
  in the repository; changing them means redeploying.
- Secrets never enter the repository.
- Setup should need as little manual work as possible. The unavoidable manual
  steps are listed in [Setup](#setup).

Out of scope for now: importance scoring, Google Workspace accounts, multiple
mailboxes.

## Architecture

```
Gmail ──(users.watch)──▶ Pub/Sub topic ──(push, OIDC)──▶ Cloudflare Worker
                                                            │
                                                            ▼
                                                   Durable Object (mailbox)
                                                     ├─ history.list
                                                     ├─ messages.get
                                                     ├─ Jev /v1/systemone
                                                     └─ messages.modify
```

Google Cloud hosts only what Gmail requires: the OAuth client and a Pub/Sub
topic with a push subscription. Everything else runs on Cloudflare.

Pub/Sub push was chosen over polling from a Worker cron because mail volume
is low and polling would mostly produce empty `history.list` calls.

### Components

| Component | Platform | Role |
| --- | --- | --- |
| OAuth client | Google Cloud | Issues the user refresh token used to call the Gmail API. |
| Pub/Sub topic | Google Cloud | Receives mailbox change notifications from Gmail. |
| Push subscription | Google Cloud | Delivers each notification to the Worker, with an OIDC token attached. |
| Worker `fetch` handler | Cloudflare | Verifies the push request and hands it to the Durable Object. |
| Worker `scheduled` handler | Cloudflare | Renews `users.watch` daily and runs a catch-up sync. |
| Durable Object `Mailbox` | Cloudflare | Owns the history cursor and serializes all processing. |

### Why a Durable Object

A Gmail notification carries only `{ emailAddress, historyId }`. Finding the
new messages means calling `history.list` from the last processed
`historyId`, so the app has to store that cursor somewhere.

Pub/Sub delivers at least once. Notifications can also arrive close
together, and Gmail drops notifications above one per second per user. A
single Durable Object instance handles this:

- Requests are serialized, so two notifications cannot read the same cursor
  and classify the same message twice (which would also mean paying Jev
  twice).
- The cursor and the set of recently processed message IDs sit in the same
  transactional storage.
- A dropped notification loses nothing. The next notification, or the daily
  catch-up, reads all history since the stored cursor.

## Processing flow

### Push notification

1. Pub/Sub sends a `POST` to the Worker's push endpoint.
2. The Worker verifies the `Authorization: Bearer` OIDC token:
   - signature checked against Google's JWKS
     (`https://www.googleapis.com/oauth2/v3/certs`)
   - `iss` is `https://accounts.google.com` or `accounts.google.com`
   - `aud` equals the configured audience
   - `email` equals the push service account and `email_verified` is true

   Requests that fail verification get `401`, and nothing is processed.
3. The Worker forwards the request to the `Mailbox` Durable Object and waits for
   the result.
4. The Durable Object:
   1. Calls `history.list` with `startHistoryId = cursor`,
      `historyTypes = messageAdded`, `labelId = INBOX`, following pagination.
   2. Collects message IDs and skips any that are already in the processed
      set, or that carry `SENT`, `DRAFT`, `SPAM`, or `TRASH`.
   3. For each remaining message: fetches it, classifies it, and adds labels
      (see [Classification](#classification)).
   4. Records each processed message ID with a timestamp, and prunes entries
      older than 7 days.
   5. Advances the cursor to the `historyId` returned by `history.list`.
5. The Worker returns `204`. On failure it returns `5xx`, and Pub/Sub
   redelivers with the backoff configured on the subscription. The cursor
   only moves after every message in the batch succeeds, and the processed
   set keeps a retry from classifying the same message again.

A message is recorded as processed only after `messages.modify` succeeds. If
Jev succeeds and the modify call fails, the retry calls Jev again for that
message. That extra call is billed but does no harm, since adding a label is
idempotent. This ordering is intentional. Recording the message before the
modify call would lose its labels if the modify call failed.

The subscription's ack deadline is set to 60 seconds. At this mail volume a
batch usually holds one message, and the Jev SDK's per-attempt timeout is
10 seconds.

The Worker's own `messages.modify` calls also create mailbox changes, which
can trigger extra notifications. Filtering `history.list` by `messageAdded`
makes these cheap no-ops, and they never loop.

### Stale cursor

If `history.list` returns `404` (the start `historyId` is too old), the Durable
Object resets the cursor to the mailbox's current `historyId` from
`users.getProfile`. Mail that arrived in the gap is not labeled. This is
acceptable because backfill is out of scope. The reset is logged.

### Daily cron

A Worker Cron Trigger runs once a day:

1. Calls `users.watch` with `topicName`, `labelIds: ["INBOX"]`, and
   `labelFilterBehavior: "INCLUDE"`. Gmail stops sending notifications if
   `watch` is not called at least every 7 days, and Google recommends calling
   it daily.
2. Runs the same sync as a push notification, to pick up anything that was
   missed.

The cron also initializes the cursor: if no cursor exists, it is set to the
`historyId` returned by `users.watch`. As a result, only mail that arrives
after the first run is processed.

## Classification

### Labels

| Label | Kind | Meaning |
| --- | --- | --- |
| `Receipt` | category | Receipts, purchase confirmations, payment notices, invoices. |
| `Shipped` | category | Shipping and delivery notices. |
| `Booking` | category | Reservations: hotels, transport, salons, cinemas, and other bookings. Overlap with `Receipt` is acceptable. |
| `ads` | category | Clearly promotional mail. |
| `Action` | flag | The recipient must act: a reply is expected, or a required task is requested. Optional surveys and similar do not count. |
| `Human` | flag | The message appears to be written by a person, not generated by a system or sent in bulk. |

Label names come from the mailbox's existing scheme. Two constraints shaped
them: Gmail reserves `Scheduled` and rejects it as a user label name, and
label names are compared case-insensitively, so `Ads` collides with an
existing `ads`.

Gmail labels are referenced by ID. At startup the Durable Object lists the
account's labels, creates any configured label that is missing, and caches
the name-to-ID map in storage.

### Jev request

Each message is one request to `POST /v1/systemone` containing three
questions.

| Question id | Type | Purpose |
| --- | --- | --- |
| `category` | Choice | `receipt`, `shipped`, `scheduled`, `ads`, `other` |
| `action` | Noul | Does the message require action from the recipient? |
| `human` | Noul | Was the message written by a person? |

Category is a single Choice with an explicit `other` option, as the Jev docs
recommend when the options may not cover every input. `Action` and `Human`
are independent of category, so each is its own Noul.

Instructions and criteria are written in English. Jev's primary language is
English, and it is less accurate on Japanese and other CJK text. The
structured criteria form (for example `focus`, `not_for`, `examples`) holds
boundary cases such as "optional surveys are not action required".

### State

The state is a JSON object built from each message:

```json
{
  "subject": "...",
  "from": { "name": "...", "address": "...", "domain": "..." },
  "to_me_directly": true,
  "gmail_category": "CATEGORY_PROMOTIONS",
  "bulk_signals": {
    "list_unsubscribe": true,
    "precedence": "bulk",
    "auto_submitted": null
  },
  "body": "plain text, truncated"
}
```

- `body` comes from `messages.get` with `format=full`. The code walks
  `payload.parts` recursively, base64url-decodes the data, and uses the
  `text/plain` part. If there is no plain part, it uses `text/html` with the
  markup removed. The body is truncated to
  keep the state well inside Jev's 32k-token limit for state plus the longest
  question. The exact limit is set in config.
- Header-derived fields do not depend on language. They help `ads` and
  `human` on Japanese mail, where the body text alone is less reliable.

### Label selection

A message gets at most 2 category labels. Flags (`Action`, `Human`) are
decided independently, each on its own threshold, and do not count toward
that limit. A message can therefore carry up to 4 labels from this app.

Flags are kept outside the limit so they never displace a category. For
example, a booking confirmation that needs a reply gets `Action`,
`Booking`, and `Receipt`.

```
labels = []

ranked = category.probabilities sorted descending, excluding "other"
if category.choice != "other" and ranked[0].p >= T_primary:
    labels.add(ranked[0])
    if ranked[1].p >= T_secondary:
        labels.add(ranked[1])

for flag in flags:
    if answers[flag].noul >= flag.threshold:
        labels.add(flag.label)
```

Worked examples for the category labels, with `T_primary = 0.5` and
`T_secondary = 0.25`:

| Probabilities | Labels |
| --- | --- |
| receipt 0.80, scheduled 0.10, other 0.10 | `Receipt` |
| receipt 0.60, scheduled 0.30, other 0.10 | `Receipt`, `Booking` |
| other 0.70, ads 0.20, ... | none |

All thresholds are in config. The initial values above are placeholders
until they are tuned with the evaluation CLI.

### Model version

Development uses `jev-latest`. After thresholds are tuned, the config pins
the versioned ID that was used (currently `jev-1.13.0`), because an alias can
move to a new model. Each Jev call logs the `model` field of the response.

## Configuration

`config/labels.json`, bundled into the Worker at build time and validated at
startup:

```json
{
  "model": "jev-latest",
  "body": { "maxChars": 2000 },
  "category": {
    "instructions": "...",
    "maxLabels": 2,
    "thresholds": { "primary": 0.5, "secondary": 0.25 },
    "options": {
      "receipt":   { "label": "Receipt",   "criteria": { "...": "..." } },
      "shipped":   { "label": "Shipped",   "criteria": { "...": "..." } },
      "scheduled": { "label": "Booking",   "criteria": { "...": "..." } },
      "ads":       { "label": "ads",       "criteria": { "...": "..." } },
      "other":     { "label": null,        "criteria": "None of the above" }
    }
  },
  "flags": {
    "action": { "label": "Action",  "threshold": 0.7, "instructions": "...", "criteria": { "...": "..." } },
    "human":  { "label": "Human",  "threshold": 0.7, "instructions": "...", "criteria": { "...": "..." } }
  }
}
```

A new category is a new entry in `options`. A new flag is a new entry in
`flags`. Neither needs a code change.

### Secrets and variables

| Name | Kind | Source |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | secret | OAuth client |
| `GOOGLE_CLIENT_SECRET` | secret | OAuth client |
| `GOOGLE_REFRESH_TOKEN` | secret | `pnpm auth:google` |
| `TYPESAFE_API_KEY` | secret | TypeSafe console |
| `GMAIL_TOPIC` | var | `projects/<project-id>/topics/<topic>` |
| `PUSH_AUDIENCE` | var | Audience set on the push subscription |
| `PUSH_SERVICE_ACCOUNT` | var | Service account email used for push auth |

Secrets go in a git-ignored file (`.secrets.env`, with a committed
`.secrets.env.example`) and are uploaded with `wrangler secret bulk`.
`.dev.vars` holds the same values for local development and is also
git-ignored. Variables live in `wrangler.jsonc`.

The Worker keeps the Gmail access token in Durable Object storage until it
expires, so it does not request a new token for every message.

## Setup

### Manual steps

1. Create a Google Cloud project, enable billing (required for Pub/Sub), and
   run `gcloud auth login`.
2. Configure the OAuth consent screen as **External** and set its publishing
   status to **In production**. A refresh token issued while the app is in
   **Testing** expires after 7 days, which would stop the Worker. The app is
   not submitted for verification. `gmail.modify` is a restricted scope, so
   consent shows an "unverified app" warning, which the account owner accepts
   once. Confirm during the first week that the refresh token keeps working.
3. Create an OAuth client of type **Desktop app**.
4. Get a TypeSafe API key.
5. Fill in `.secrets.env`.

The Google console does not offer a supported API for steps 2 and 3 on
consumer projects, so they stay manual.

### Scripted steps

| Command | Does |
| --- | --- |
| `pnpm auth:google` | Runs a local loopback OAuth flow with scope `gmail.modify` and writes the refresh token into `.secrets.env`. |
| `pnpm setup:gcp` | Idempotent `gcloud` script: enables the Gmail and Pub/Sub APIs, creates the topic, grants `roles/pubsub.publisher` on it to `gmail-api-push@system.gserviceaccount.com`, creates the push service account, grants `roles/iam.serviceAccountTokenCreator` on that account to the Pub/Sub service agent (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`, which Google does not grant automatically), and creates or updates the push subscription pointing at the Worker URL (OIDC auth, 60 s ack deadline, explicit `--min-retry-delay`/`--max-retry-delay` so failures back off instead of retrying immediately). |
| `pnpm deploy` | `wrangler deploy` followed by `wrangler secret bulk .secrets.env`. |
| `pnpm watch:start` | Calls the Worker's cron logic once, so `users.watch` starts and the cursor is set without waiting for the first scheduled run. |

On first setup, `deploy` must run before `setup:gcp` because the subscription
needs the Worker URL.

## Evaluation before going live

Jev is less accurate on Japanese text, so thresholds are tuned on real mail
before automatic labeling is enabled.

`pnpm eval` is a local Node CLI that uses the same OAuth credentials and the
same state builder and question set as the Worker. It:

1. Fetches the N most recent inbox messages (read only).
2. Sends each to Jev.
3. Prints subject, sender, category probabilities, `confidence`, each flag
   value, and the labels the selection rule would add.
4. Optionally writes CSV output for review.

It never modifies the mailbox.

## Tech stack

- TypeScript, pnpm, Node.js 20+ for local scripts
- Cloudflare Workers with Durable Objects (SQLite-backed) and Cron Triggers
- `@typesafe-ai/sdk` for Jev
- Gmail REST API called with `fetch`. The `googleapis` package depends on
  Node APIs that the Workers runtime does not provide.
- `jose` for OIDC token verification
- Vitest with `@cloudflare/vitest-pool-workers`

## Cost and data handling

- Jev charges only for input tokens, at $0.042 per million. At a few thousand
  tokens per message, personal mail volume costs cents per month.
- Pub/Sub and Workers usage at this volume stays within their free tiers.
- Message content (headers and a truncated body) is sent to TypeSafe. TypeSafe
  states that customer requests are not used for training. Zero data
  retention is offered only on enterprise plans.

## Open items


- Importance scoring, deferred.
- Whether low-confidence results should get a `Review` label to help tune
  thresholds.

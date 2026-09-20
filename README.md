# Gmail auto-labeling

Automatically labels new mail in one personal Gmail inbox. Gmail pushes
change notifications through Pub/Sub to a Cloudflare Worker; a Durable Object
owns the history cursor, fetches new messages, classifies them with Jev
(TypeSafe's System One model), and adds up to two category labels (`Receipt`,
`Shipped`, `Scheduled`, `Ads`) plus independent flag labels (`Action`,
`Human`). Labels are only ever added — nothing is ever removed or changed,
and existing mail is never backfilled. See `docs/design.md` for the full
design.

A local CLI, `pnpm eval`, runs the same classifier read-only over recent mail
so the criteria in `config/labels.json` can be tuned before anything is
labeled automatically.

## Manual steps (Google Cloud console)

These have no supported API on a consumer project, so they cannot be
scripted.

1. Create a Google Cloud project, enable billing (required for Pub/Sub), and
   run `gcloud auth login`.
2. Configure the OAuth consent screen as **External** and add the Gmail
   account as a test user (required while it's in **Testing**, see below).
   Leave its publishing status at **Testing** for now — the two URLs it asks
   for (homepage, privacy policy) are served by the Worker itself at `/` and
   `/privacy`, and the Worker's URL is not known until the first deploy (see
   the scripted flow below). Once the Worker is deployed and those URLs are
   set, switch the publishing status to **In production**. A refresh token
   issued while the app is still in **Testing** expires after 7 days
   regardless of when the app is later published, so re-run `pnpm auth:google`
   and `pnpm deploy` once the app is in production to replace it (see step 9
   below); check `pnpm exec wrangler tail` during the following week to
   confirm the token keeps working. The app is not submitted for Google's
   verification review; `gmail.modify` is a restricted scope, so consent
   shows an "unverified app" warning that the account owner accepts once.
3. Create an OAuth client of type **Desktop app**. Note its client ID and
   secret.
4. Get a TypeSafe API key.

## Local files

| File | Purpose |
| --- | --- |
| `.secrets.env` | Everything the Worker reads at runtime. Uploaded to Cloudflare by `pnpm deploy` (`wrangler secret bulk`, skipping any key that's still empty); never committed. Copy `.secrets.env.example` to start it. |
| `.env` | Inputs to the setup scripts only (`GCP_PROJECT_ID`, `WORKER_URL`, and a few optional overrides). Never uploaded anywhere. Copy `.env.example` to start it. |
| `.dev.vars` | A copy of `.secrets.env`, read by `wrangler dev` for local development. Not written by any script. |
| `config/labels.json` | The label criteria Jev is prompted with. Tune this after running `pnpm eval`. |

## Scripted flow

Run these in order.

1. Copy `.secrets.env.example` to `.secrets.env` and `.env.example` to `.env`.
   Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (from the manual
   steps above), `TYPESAFE_API_KEY`, and a random `ADMIN_TOKEN` (for example
   `openssl rand -hex 32`) in `.secrets.env`; fill in `GCP_PROJECT_ID` in
   `.env`. Leave `GOOGLE_REFRESH_TOKEN`, `GMAIL_TOPIC`, `PUSH_AUDIENCE`,
   `PUSH_SERVICE_ACCOUNT`, and `WORKER_URL` blank — the steps below fill
   those in. `CONTACT_EMAIL` and `SITE_VERIFICATION` are optional and not
   secrets: if set, they show up on `/` and `/privacy` and, for the latter,
   as a Search Console verification meta tag.
2. `pnpm auth:google` — runs a local loopback OAuth flow with scope
   `gmail.modify` and writes `GOOGLE_REFRESH_TOKEN` into `.secrets.env`.
3. `pnpm eval --count 30` — classifies the 30 most recent messages read-only
   and prints each one's result plus a summary; add `--csv <path>` to also
   write a CSV for closer review. Tune `config/labels.json` and rerun until
   the output looks right. Note that `Action` is just the name chosen for the
   "needs a reply" flag label; rename it in `config/labels.json` (and in the
   design doc, for consistency) if a different name reads better.
4. `pnpm deploy` — the first time, this only runs `wrangler deploy` and
   uploads whichever secrets are already filled in; `GMAIL_TOPIC`,
   `PUSH_AUDIENCE`, and `PUSH_SERVICE_ACCOUNT` are still empty at this point,
   which is expected. Copy the `*.workers.dev` URL it prints into `WORKER_URL`
   in `.env`.
5. `pnpm setup:gcp` — idempotent `gcloud` script: enables the Gmail and
   Pub/Sub APIs, creates the Pub/Sub topic, grants Gmail's push service
   account permission to publish to it, creates a push service account,
   grants the Pub/Sub service agent permission to mint tokens as it, and
   creates or updates a push subscription pointing at `WORKER_URL`. Writes
   `GMAIL_TOPIC`, `PUSH_AUDIENCE`, and `PUSH_SERVICE_ACCOUNT` into
   `.secrets.env`.
6. `pnpm deploy` again — this time uploads the values `setup:gcp` just wrote.
7. `pnpm watch:start` — calls the Worker's cron logic once (bearer
   `ADMIN_TOKEN`), so `users.watch` starts and the history cursor is set
   without waiting for the first scheduled run. Prints the JSON response;
   exits non-zero if the request failed.
8. Verify: run `pnpm exec wrangler tail` in one terminal, send a test mail to
   the account, and confirm a label is applied within about a minute.
9. Go back to the consent screen and set its publishing status to
   **In production**. Then run `pnpm auth:google` again and `pnpm deploy`
   once more, so the Worker holds a refresh token issued under production
   status rather than the 7-day one from step 2.

## Everyday use

Nothing further to run day to day: the Worker's cron trigger renews the Gmail
watch and catches up on any missed history once a day, and pushed
notifications label mail as it arrives. Redeploy (`pnpm deploy`) after
changing `config/labels.json` or any source file.

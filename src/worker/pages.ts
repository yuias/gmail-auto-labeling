import type { Env } from "./env";

// Both pages are static, unauthenticated HTML with no build step: the Worker
// already has a public URL, and the OAuth consent screen needs a homepage and
// a privacy policy on that same domain (see the privacy policy text below).
type PublicEnv = Pick<Env, "CONTACT_EMAIL" | "SITE_VERIFICATION">;

const LAST_UPDATED = "2026-09-20";

function page(title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${head}</head>
<body>
${body}
</body>
</html>
`;
}

function contactLine(env: PublicEnv): string {
  return env.CONTACT_EMAIL ? `<p>Contact: ${env.CONTACT_EMAIL}</p>` : "";
}

export function homepageHtml(env: PublicEnv): string {
  const head = env.SITE_VERIFICATION
    ? `<meta name="google-site-verification" content="${env.SITE_VERIFICATION}">\n`
    : "";
  const body = `<h1>Gmail auto-labeling</h1>
<p>
  This is a personal, single-user tool. It watches one Gmail inbox, classifies
  each incoming message, and adds a label describing what it is (for example
  Receipt, Shipped, Scheduled, or Ads) plus flags such as whether it needs a
  reply. It never deletes mail and never removes a label.
</p>
<p>There is no sign-up and no accounts: it serves one inbox only.</p>
<p><a href="/privacy">Privacy policy</a></p>
${contactLine(env)}`;
  return page("Gmail auto-labeling", head, body);
}

export function privacyHtml(env: PublicEnv): string {
  const body = `<h1>Privacy policy</h1>
<p>Last updated: ${LAST_UPDATED}</p>

<h2>What this is</h2>
<p>
  A personal, single-user tool that labels incoming mail in one Gmail
  account. It has no sign-up, no accounts, and no other users.
</p>

<h2>What it accesses</h2>
<p>
  Through the Gmail API with the <code>gmail.modify</code> scope, it reads the
  headers and text of messages that arrive in that one inbox and adds labels
  to them. It never deletes mail, never removes a label, and never sends
  mail.
</p>

<h2>What leaves Google</h2>
<p>
  For each incoming message, the subject, the sender's name/address/domain, a
  few header-derived signals, and the message's plain-text body (truncated to
  a fixed length) are sent to TypeSafe (<code>api.typesafe.ai</code>) to be
  classified. TypeSafe states that it does not train on customer requests.
</p>
<p>
  The Worker itself runs on Cloudflare, which hosts the code and its stored
  state (see "What is stored" below) as the infrastructure provider. No other
  third party receives message content.
</p>

<h2>What is stored</h2>
<p>
  In per-account Durable Object storage: a Gmail history cursor, the account's
  own email address, a cached OAuth access token and its expiry, the current
  Gmail watch's expiry, the ids of recently processed messages (kept about
  seven days), the ids of messages that failed classification and their retry
  count (also kept about seven days), and a cache of this app's label ids.
  Message subjects, senders, and bodies are not stored after a message is
  classified. Operational logs, which Cloudflare retains as part of running
  the Worker, carry Gmail message and history ids, the account address
  included in each push notification, and the labeling outcome (which labels
  were applied, and the classifier's model name, choice, and confidence) —
  never a subject, sender, or body.
</p>
<p>
  The Gmail OAuth client secret, refresh token, and the TypeSafe API key are
  held as Cloudflare Worker secrets, not in application storage.
</p>

<h2>Analytics and sharing</h2>
<p>
  No analytics. Nothing is sold or used for advertising, and nothing is
  shared beyond the classification calls and hosting described above.
</p>

<h2>Limited Use</h2>
<p>
  This app's use of information received from Google APIs adheres to the
  Google API Services User Data Policy, including the Limited Use
  requirements.
</p>

<h2>Revoking access</h2>
<p>
  The account owner can revoke this app's access at
  <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>,
  which stops all access immediately.
</p>

<h2>Changes and contact</h2>
<p>This policy may change; the date above reflects the last update.</p>
${contactLine(env)}`;
  return page("Privacy policy", "", body);
}

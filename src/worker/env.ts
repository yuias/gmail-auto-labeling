export interface Env {
  MAILBOX: DurableObjectNamespace<import("./mailbox").Mailbox>;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  TYPESAFE_API_KEY: string;
  ADMIN_TOKEN: string;
  GMAIL_TOPIC: string;
  PUSH_AUDIENCE: string;
  PUSH_SERVICE_ACCOUNT: string;
  PUSH_JWKS_URL?: string; // tests only; defaults to Google's JWKS
  CONTACT_EMAIL?: string; // optional; shown on the public pages when set
  SITE_VERIFICATION?: string; // optional; Search Console verification meta tag
}

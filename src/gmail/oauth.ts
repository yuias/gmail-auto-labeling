import type { TokenSource } from "./types";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function postForm(
  url: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`oauth: token request failed with ${response.status}: ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresAt: number }> {
  const data = await postForm(
    GOOGLE_TOKEN_URL,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  return { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

export function buildAuthUrl(client: OAuthClient, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_MODIFY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  client: OAuthClient,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const data = await postForm(
    GOOGLE_TOKEN_URL,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
  if (!data.refresh_token) {
    throw new Error("oauth: token response did not include a refresh_token");
  }
  return { refreshToken: data.refresh_token, accessToken: data.access_token };
}

// Refreshes on demand and caches the access token until shortly before it
// expires, so callers can call getAccessToken() freely without extra network
// round trips.
export class MemoryTokenSource implements TokenSource {
  private cached: { accessToken: string; expiresAt: number } | undefined;

  constructor(
    private readonly client: OAuthClient,
    private readonly refreshToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (opts?.forceRefresh || !this.cached || this.cached.expiresAt - 60_000 <= Date.now()) {
      this.cached = await refreshAccessToken(this.client, this.refreshToken, this.fetchImpl);
    }
    return this.cached.accessToken;
  }
}

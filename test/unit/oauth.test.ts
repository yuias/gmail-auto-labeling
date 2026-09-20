import { describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  GOOGLE_TOKEN_URL,
  MemoryTokenSource,
  type OAuthClient,
  refreshAccessToken,
} from "../../src/gmail/oauth";

const client: OAuthClient = { clientId: "client-id", clientSecret: "client-secret" };

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[calls.length - 1] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("refreshAccessToken", () => {
  it("posts form-encoded grant_type=refresh_token and returns expiresAt from expires_in", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { access_token: "at-1", expires_in: 3600 } },
    ]);
    const before = Date.now();
    const result = await refreshAccessToken(client, "refresh-token", impl);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GOOGLE_TOKEN_URL);
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");

    expect(result.accessToken).toBe("at-1");
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });
});

describe("buildAuthUrl", () => {
  it("contains scope, access_type=offline, prompt=consent, redirect URI, and state", () => {
    const url = new URL(buildAuthUrl(client, "http://127.0.0.1:5555/callback", "the-state"));
    expect(url.searchParams.get("scope")).toBe(GMAIL_MODIFY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/callback");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("client_id")).toBe("client-id");
  });
});

describe("exchangeCode", () => {
  it("throws when refresh_token is absent", async () => {
    const { impl } = fakeFetch([{ status: 200, body: { access_token: "at-1", expires_in: 3600 } }]);
    await expect(exchangeCode(client, "code", "http://127.0.0.1/callback", impl)).rejects.toThrow(
      /refresh_token/,
    );
  });

  it("returns the refresh and access tokens when present", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { access_token: "at-1", expires_in: 3600, refresh_token: "rt-1" } },
    ]);
    const result = await exchangeCode(client, "code", "http://127.0.0.1/callback", impl);
    expect(result).toEqual({ refreshToken: "rt-1", accessToken: "at-1" });
  });
});

describe("MemoryTokenSource", () => {
  it("refreshes only when expired or forced", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { access_token: "at-1", expires_in: 3600 } },
      { status: 200, body: { access_token: "at-2", expires_in: 3600 } },
    ]);
    const source = new MemoryTokenSource(client, "refresh-token", impl);

    expect(await source.getAccessToken()).toBe("at-1");
    expect(await source.getAccessToken()).toBe("at-1");
    expect(calls).toHaveLength(1);

    expect(await source.getAccessToken({ forceRefresh: true })).toBe("at-2");
    expect(calls).toHaveLength(2);
  });

  it("refreshes again once the cached token is within 60s of expiry", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { access_token: "at-1", expires_in: 30 } },
      { status: 200, body: { access_token: "at-2", expires_in: 3600 } },
    ]);
    const source = new MemoryTokenSource(client, "refresh-token", impl);

    expect(await source.getAccessToken()).toBe("at-1");
    expect(await source.getAccessToken()).toBe("at-2");
    expect(calls).toHaveLength(2);
  });
});

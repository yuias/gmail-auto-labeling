import { describe, expect, it } from "vitest";
import { GmailApiError, GmailClient } from "../../src/gmail/client";
import type { TokenSource } from "../../src/gmail/types";

interface FakeCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

class FakeTokens implements TokenSource {
  refreshCalls = 0;
  constructor(private token = "access-token") {}
  async getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (opts?.forceRefresh) {
      this.refreshCalls++;
      this.token = "access-token-refreshed";
    }
    return this.token;
  }
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: FakeCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      authorization: headers.get("Authorization"),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const response = responses[calls.length - 1];
    return new Response(response.body === undefined ? "" : JSON.stringify(response.body), {
      status: response.status,
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("GmailClient", () => {
  it("getProfile: URL, bearer header", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      { status: 200, body: { emailAddress: "me@example.com", historyId: "123" } },
    ]);
    const client = new GmailClient(tokens, impl);

    const profile = await client.getProfile();

    expect(profile).toEqual({ emailAddress: "me@example.com", historyId: "123" });
    expect(calls[0].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(calls[0].authorization).toBe("Bearer access-token");
  });

  it("listMessages: URL and query", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      { status: 200, body: { messages: [{ id: "1", threadId: "t1" }], nextPageToken: "np" } },
    ]);
    const client = new GmailClient(tokens, impl);

    const result = await client.listMessages({
      labelIds: ["INBOX", "UNREAD"],
      q: "is:unread",
      maxResults: 10,
    });

    expect(result).toEqual({ messages: [{ id: "1", threadId: "t1" }], nextPageToken: "np" });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(url.searchParams.getAll("labelIds")).toEqual(["INBOX", "UNREAD"]);
    expect(url.searchParams.get("q")).toBe("is:unread");
    expect(url.searchParams.get("maxResults")).toBe("10");
  });

  it("listMessages: defaults nextPageToken and messages when absent", async () => {
    const tokens = new FakeTokens();
    const { impl } = fakeFetch([{ status: 200, body: {} }]);
    const client = new GmailClient(tokens, impl);

    expect(await client.listMessages({})).toEqual({ messages: [], nextPageToken: undefined });
  });

  it("getMessage: URL includes format=full", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: "m1", threadId: "t1" } }]);
    const client = new GmailClient(tokens, impl);

    await client.getMessage("m1");

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/m1");
    expect(url.searchParams.get("format")).toBe("full");
  });

  it("modifyMessage: body has only addLabelIds", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    const client = new GmailClient(tokens, impl);

    await client.modifyMessage("m1", ["Label_1", "Label_2"]);

    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/m1/modify");
    expect(calls[0].body).toEqual({ addLabelIds: ["Label_1", "Label_2"] });
  });

  it("401 then 200 triggers exactly one forced refresh and succeeds", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { emailAddress: "me@example.com", historyId: "123" } },
    ]);
    const client = new GmailClient(tokens, impl);

    const profile = await client.getProfile();

    expect(profile).toEqual({ emailAddress: "me@example.com", historyId: "123" });
    expect(tokens.refreshCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].authorization).toBe("Bearer access-token");
    expect(calls[1].authorization).toBe("Bearer access-token-refreshed");
  });

  it("403 throws GmailApiError with status and body", async () => {
    const tokens = new FakeTokens();
    const { impl } = fakeFetch([
      { status: 403, body: { error: "forbidden" } },
      { status: 403, body: { error: "forbidden" } },
    ]);
    const client = new GmailClient(tokens, impl);

    await expect(client.getProfile()).rejects.toBeInstanceOf(GmailApiError);
    await expect(client.getProfile()).rejects.toMatchObject({
      status: 403,
      body: JSON.stringify({ error: "forbidden" }),
    });
  });

  it("declares the not-yet-implemented methods, which throw for now", async () => {
    const tokens = new FakeTokens();
    const { impl } = fakeFetch([]);
    const client = new GmailClient(tokens, impl);

    await expect(client.listHistory({ startHistoryId: "1" })).rejects.toThrow("not implemented");
    await expect(client.listLabels()).rejects.toThrow("not implemented");
    await expect(client.createLabel("Label")).rejects.toThrow("not implemented");
    await expect(
      client.watch({ topicName: "t", labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }),
    ).rejects.toThrow("not implemented");
  });
});

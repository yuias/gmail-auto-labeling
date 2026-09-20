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

  it("listHistory: follows nextPageToken and dedupes messages, keeping the last page's historyId", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          history: [
            {
              messagesAdded: [
                { message: { id: "m1", threadId: "t1", labelIds: ["INBOX"] } },
                { message: { id: "m2", threadId: "t2", labelIds: ["INBOX"] } },
              ],
            },
          ],
          historyId: "100",
          nextPageToken: "page2",
        },
      },
      {
        status: 200,
        body: {
          history: [
            {
              // m2 repeats across pages; the first occurrence must win.
              messagesAdded: [
                { message: { id: "m2", threadId: "t2", labelIds: ["INBOX", "UNREAD"] } },
                { message: { id: "m3", threadId: "t3", labelIds: [] } },
              ],
            },
          ],
          historyId: "200",
        },
      },
    ]);
    const client = new GmailClient(tokens, impl);

    const result = await client.listHistory({
      startHistoryId: "50",
      labelId: "INBOX",
      historyTypes: ["messageAdded"],
    });

    expect(result).toEqual({
      historyId: "200",
      messagesAdded: [
        { id: "m1", threadId: "t1", labelIds: ["INBOX"] },
        { id: "m2", threadId: "t2", labelIds: ["INBOX"] },
        { id: "m3", threadId: "t3", labelIds: [] },
      ],
    });
    expect(calls).toHaveLength(2);
    const firstUrl = new URL(calls[0].url);
    expect(firstUrl.pathname).toBe("/gmail/v1/users/me/history");
    expect(firstUrl.searchParams.get("startHistoryId")).toBe("50");
    expect(firstUrl.searchParams.get("labelId")).toBe("INBOX");
    expect(firstUrl.searchParams.getAll("historyTypes")).toEqual(["messageAdded"]);
    expect(firstUrl.searchParams.get("pageToken")).toBeNull();
    const secondUrl = new URL(calls[1].url);
    expect(secondUrl.searchParams.get("pageToken")).toBe("page2");
  });

  it("listHistory: a response without history still returns an empty list and the historyId", async () => {
    const tokens = new FakeTokens();
    const { impl } = fakeFetch([{ status: 200, body: { historyId: "42" } }]);
    const client = new GmailClient(tokens, impl);

    expect(await client.listHistory({ startHistoryId: "1" })).toEqual({
      historyId: "42",
      messagesAdded: [],
    });
  });

  it("listHistory: 404 propagates as GmailApiError", async () => {
    const tokens = new FakeTokens();
    const { impl } = fakeFetch([
      { status: 404, body: { error: "not found" } },
      { status: 404, body: { error: "not found" } },
    ]);
    const client = new GmailClient(tokens, impl);

    await expect(client.listHistory({ startHistoryId: "1" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("listLabels: returns the labels array", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      { status: 200, body: { labels: [{ id: "Label_1", name: "Receipt" }] } },
    ]);
    const client = new GmailClient(tokens, impl);

    expect(await client.listLabels()).toEqual([{ id: "Label_1", name: "Receipt" }]);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/labels");
  });

  it("createLabel: body includes the visibility fields", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: "Label_1", name: "Receipt" } }]);
    const client = new GmailClient(tokens, impl);

    const label = await client.createLabel("Receipt");

    expect(label).toEqual({ id: "Label_1", name: "Receipt" });
    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/labels");
    expect(calls[0].body).toEqual({
      name: "Receipt",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
  });

  it("watch: posts the three fields and returns historyId/expiration", async () => {
    const tokens = new FakeTokens();
    const { impl, calls } = fakeFetch([
      { status: 200, body: { historyId: "1", expiration: "1700000000000" } },
    ]);
    const client = new GmailClient(tokens, impl);

    const result = await client.watch({
      topicName: "projects/p/topics/gmail",
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });

    expect(result).toEqual({ historyId: "1", expiration: "1700000000000" });
    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/gmail/v1/users/me/watch");
    expect(calls[0].body).toEqual({
      topicName: "projects/p/topics/gmail",
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
  });
});

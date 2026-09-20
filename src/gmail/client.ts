import type { GmailLabel, GmailMessage, HistoryResult, TokenSource } from "./types";

export type { TokenSource } from "./types";

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`gmail: ${status} on ${url}: ${body}`);
    this.name = "GmailApiError";
  }
}

export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessages(params: {
    labelIds?: string[];
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }>;
  getMessage(id: string): Promise<GmailMessage>;
  modifyMessage(id: string, addLabelIds: string[]): Promise<void>;
  listHistory(params: {
    startHistoryId: string;
    labelId?: string;
    historyTypes?: string[];
  }): Promise<HistoryResult>;
  listLabels(): Promise<GmailLabel[]>;
  createLabel(name: string): Promise<GmailLabel>;
  watch(body: {
    topicName: string;
    labelIds: string[];
    labelFilterBehavior: "INCLUDE" | "EXCLUDE";
  }): Promise<{ historyId: string; expiration: string }>;
}

type QueryValue = string | number | string[] | undefined;

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export class GmailClient implements GmailApi {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://gmail.googleapis.com/gmail/v1/users/me",
  ) {}

  // Handles the bearer header, a single forced-refresh retry on 401, JSON
  // parsing, and wrapping any other non-2xx response in GmailApiError.
  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const accessToken = await this.tokens.getAccessToken({ forceRefresh });
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      return this.fetchImpl(url, { method, headers, body });
    };

    let response = await send(false);
    if (response.status === 401) {
      response = await send(true);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new GmailApiError(response.status, text, url);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.request("GET", "/profile");
  }

  async listMessages(params: {
    labelIds?: string[];
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
    const result = await this.request<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    }>("GET", "/messages", { query: params });
    return { messages: result.messages ?? [], nextPageToken: result.nextPageToken };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return this.request("GET", `/messages/${id}`, { query: { format: "full" } });
  }

  async modifyMessage(id: string, addLabelIds: string[]): Promise<void> {
    await this.request("POST", `/messages/${id}/modify`, { body: { addLabelIds } });
  }

  async listHistory(_params: {
    startHistoryId: string;
    labelId?: string;
    historyTypes?: string[];
  }): Promise<HistoryResult> {
    throw new Error("not implemented");
  }

  async listLabels(): Promise<GmailLabel[]> {
    throw new Error("not implemented");
  }

  async createLabel(_name: string): Promise<GmailLabel> {
    throw new Error("not implemented");
  }

  async watch(_body: {
    topicName: string;
    labelIds: string[];
    labelFilterBehavior: "INCLUDE" | "EXCLUDE";
  }): Promise<{ historyId: string; expiration: string }> {
    throw new Error("not implemented");
  }
}

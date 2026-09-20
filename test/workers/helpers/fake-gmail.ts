import { type GmailApi, GmailApiError } from "../../../src/gmail/client";
import type { GmailLabel, GmailMessage, HistoryResult } from "../../../src/gmail/types";

export interface FakeGmailCall {
  method: string;
  args: unknown[];
}

// In-memory GmailApi for Mailbox tests: state is plain public fields the test
// sets up directly, every call is recorded in `calls`, and `failNext` queues
// a one-shot error (typically a GmailApiError) for a given method.
export class FakeGmailApi implements GmailApi {
  readonly calls: FakeGmailCall[] = [];

  profile: { emailAddress: string; historyId: string } = {
    emailAddress: "me@example.com",
    historyId: "1",
  };
  labels: GmailLabel[] = [];
  messages = new Map<string, GmailMessage>();
  history: HistoryResult = { historyId: "1", messagesAdded: [] };
  watchResult: { historyId: string; expiration: string } = { historyId: "1", expiration: "0" };
  // message id -> label ids added via modifyMessage, in call order.
  modifiedLabels = new Map<string, string[]>();

  private readonly failures = new Map<string, Error>();

  failNext(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const error = this.failures.get(method);
    if (error) {
      this.failures.delete(method);
      throw error;
    }
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    this.record("getProfile", []);
    return this.profile;
  }

  async listMessages(params: {
    labelIds?: string[];
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
    this.record("listMessages", [params]);
    return { messages: [] };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    this.record("getMessage", [id]);
    const message = this.messages.get(id);
    if (!message) throw new GmailApiError(404, "message not found", `/messages/${id}`);
    return message;
  }

  async modifyMessage(id: string, addLabelIds: string[]): Promise<void> {
    this.record("modifyMessage", [id, addLabelIds]);
    const existing = this.modifiedLabels.get(id) ?? [];
    this.modifiedLabels.set(id, [...existing, ...addLabelIds]);
  }

  async listHistory(params: {
    startHistoryId: string;
    labelId?: string;
    historyTypes?: string[];
  }): Promise<HistoryResult> {
    this.record("listHistory", [params]);
    return this.history;
  }

  async listLabels(): Promise<GmailLabel[]> {
    this.record("listLabels", []);
    return this.labels;
  }

  async createLabel(name: string): Promise<GmailLabel> {
    this.record("createLabel", [name]);
    const label: GmailLabel = { id: `label_${name}`, name };
    this.labels.push(label);
    return label;
  }

  async watch(body: {
    topicName: string;
    labelIds: string[];
    labelFilterBehavior: "INCLUDE" | "EXCLUDE";
  }): Promise<{ historyId: string; expiration: string }> {
    this.record("watch", [body]);
    return this.watchResult;
  }
}

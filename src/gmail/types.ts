export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: GmailPart;
}
export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}
export interface HistoryResult {
  historyId: string; // mailbox's current history id from the last page
  messagesAdded: Array<{ id: string; threadId: string; labelIds: string[] }>; // deduped by id, first occurrence order
}

// Shared by src/gmail/oauth.ts and src/gmail/client.ts (not assigned a
// dedicated file in the directory layout).
export interface TokenSource {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

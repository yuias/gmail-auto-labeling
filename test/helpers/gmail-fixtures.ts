import type { GmailHeader, GmailMessage, GmailPart } from "../../src/gmail/types";

// Runtime-agnostic base64url encoder (no `Buffer`), mirroring the decoder in
// `src/core/mime.ts`. Used by tests to build fixture message bodies.
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface MakeMessageOptions {
  id?: string;
  headers: GmailHeader[];
  labelIds?: string[];
  text?: string;
  html?: string;
  parts?: GmailPart[];
}

// Builds a `GmailMessage` shaped like the real Gmail REST resource. Passing
// `parts` gives full control over the payload tree (nested multipart,
// attachments); `text`/`html` cover the common single- or dual-body case.
export function makeMessage(opts: MakeMessageOptions): GmailMessage {
  const { id = "msg-1", headers, labelIds, text, html, parts } = opts;

  let payload: GmailPart;
  if (parts) {
    payload = { mimeType: "multipart/mixed", headers, parts };
  } else if (text !== undefined && html !== undefined) {
    payload = {
      mimeType: "multipart/alternative",
      headers,
      parts: [
        { mimeType: "text/plain", body: { size: text.length, data: encodeBase64Url(text) } },
        { mimeType: "text/html", body: { size: html.length, data: encodeBase64Url(html) } },
      ],
    };
  } else if (text !== undefined) {
    payload = {
      mimeType: "text/plain",
      headers,
      body: { size: text.length, data: encodeBase64Url(text) },
    };
  } else if (html !== undefined) {
    payload = {
      mimeType: "text/html",
      headers,
      body: { size: html.length, data: encodeBase64Url(html) },
    };
  } else {
    payload = { mimeType: "text/plain", headers, body: { size: 0 } };
  }

  return { id, threadId: id, labelIds, payload };
}

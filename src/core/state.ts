import type { GmailMessage } from "../gmail/types";
import {
  extractBody,
  getHeader,
  htmlToText,
  normalizeAddress,
  normalizeWhitespace,
  parseAddress,
  parseAddressList,
} from "./mime";
import type { MessageState } from "./types";

export function buildState(
  message: GmailMessage,
  opts: { selfAddress: string; maxChars: number },
): MessageState {
  const headers = message.payload?.headers;

  const subject = getHeader(headers, "Subject") ?? "";

  const fromHeader = getHeader(headers, "From");
  const from = fromHeader ? parseAddress(fromHeader) : { name: null, address: null, domain: null };

  const toHeader = getHeader(headers, "To");
  const toAddresses = toHeader ? parseAddressList(toHeader).map(normalizeAddress) : [];
  const to_me_directly = toAddresses.includes(normalizeAddress(opts.selfAddress));

  const gmail_category = (message.labelIds ?? []).find((id) => id.startsWith("CATEGORY_")) ?? null;

  const listUnsubscribe = getHeader(headers, "List-Unsubscribe");
  const precedence = getHeader(headers, "Precedence");
  const autoSubmitted = getHeader(headers, "Auto-Submitted");

  const { text, html } = extractBody(message.payload);
  const rawBody = text !== null ? normalizeWhitespace(text) : html !== null ? htmlToText(html) : "";
  const body = rawBody.slice(0, opts.maxChars);

  return {
    subject,
    from,
    to_me_directly,
    gmail_category,
    bulk_signals: {
      list_unsubscribe: listUnsubscribe !== null,
      precedence: precedence?.toLowerCase() ?? null,
      auto_submitted: autoSubmitted?.toLowerCase() ?? null,
    },
    body,
  };
}

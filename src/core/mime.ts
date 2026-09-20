import type { GmailHeader, GmailPart } from "../gmail/types";

// Gmail's base64url has no padding; accept it with or without and normalize
// to standard base64 before decoding. `atob` returns Latin-1 bytes, so a
// TextDecoder pass is required to recover multibyte UTF-8 text correctly.
export function decodeBase64Url(data: string): string {
  // Strip whitespace and padding first: Gmail wraps long `body.data` values,
  // and `=` only ever appears as padding, so re-padding a clean string is safe.
  const base64 = data.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function getHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const found = headers.find((header) => header.name.toLowerCase() === lower);
  return found ? found.value : null;
}

export interface ParsedAddress {
  name: string | null;
  address: string | null;
  domain: string | null;
}

// Handles `"Name" <addr>`, `Name <addr>`, and a bare `addr`. Gmail already
// RFC 2047-decodes header values, so no MIME-word handling is needed here.
export function parseAddress(value: string): ParsedAddress {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.*)<([^<>]+)>$/);

  let name: string | null = null;
  let address: string | null = null;

  if (match) {
    name = match[1].trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1);
    }
    if (name === "") name = null;
    address = match[2].trim();
  } else if (trimmed !== "") {
    address = trimmed;
  }

  if (address) address = address.toLowerCase();
  const domain = address?.includes("@") ? address.slice(address.indexOf("@") + 1) : null;

  return { name, address, domain };
}

// Splits a comma-separated address list, ignoring commas inside a quoted
// display name (e.g. `"Doe, Jane" <jane@example.com>, bob@example.com`).
export function parseAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") parts.push(current);

  return parts
    .map((part) => parseAddress(part).address)
    .filter((address): address is string => address !== null);
}

// Marketing HTML carries malformed numeric entities. Out-of-range values,
// lone surrogates, and NUL would make `String.fromCodePoint` throw or put an
// unusable character into the state, so the original text is kept instead.
function codePointToText(codePoint: number, original: string): string {
  if (!Number.isFinite(codePoint)) return original;
  if (codePoint < 1 || codePoint > 0x10ffff) return original;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return original;
  return String.fromCodePoint(codePoint);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (match, dec: string) => codePointToText(Number(dec), match))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) =>
      codePointToText(Number.parseInt(hex, 16), match),
    )
    .replace(/&amp;/g, "&"); // decoded last so `&amp;lt;` yields the literal text `&lt;`
}

// Collapses horizontal whitespace per line, trims each line, and caps
// consecutive blank lines at one. Used for both HTML-derived and plain text.
export function normalizeWhitespace(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim());
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Minimal hand-rolled stripper: no DOM or dependency, just enough to turn a
// marketing/transactional email body into readable plain text for the model.
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n");
  // Receipts and shipping notices lay values out in table cells; without a
  // separator adjacent cells fuse into one token.
  text = text.replace(/<\/(td|th)>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return normalizeWhitespace(text);
}

export interface ExtractedBody {
  text: string | null;
  html: string | null;
}

// Depth-first walk of the payload tree: top-level `body.data` covers
// non-multipart messages, `parts` covers multipart ones. Attachments
// (a non-empty `filename`) are skipped so they never become the body.
export function extractBody(payload: GmailPart | undefined): ExtractedBody {
  let text: string | null = null;
  let html: string | null = null;

  function walk(part: GmailPart): void {
    if (part.filename) return;

    if (part.mimeType === "text/plain" && part.body?.data && text === null) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data && html === null) {
      html = decodeBase64Url(part.body.data);
    }

    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  if (payload) walk(payload);
  return { text, html };
}

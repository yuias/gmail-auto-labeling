import { describe, expect, it } from "vitest";
import { buildState } from "../../src/core/state";
import type { GmailMessage } from "../../src/gmail/types";
import { encodeBase64Url, makeMessage } from "../helpers/gmail-fixtures";

const selfAddress = "me@example.com";

describe("buildState", () => {
  it("prefers the plain-text part over html in multipart/alternative", () => {
    const message = makeMessage({
      headers: [{ name: "Subject", value: "Hi" }],
      text: "plain body",
      html: "<p>html body</p>",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.body).toBe("plain body");
  });

  it("converts an html-only message to text", () => {
    const message = makeMessage({
      headers: [{ name: "Subject", value: "Hi" }],
      html: "<p>Hello</p><p>World</p>",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.body).toBe("Hello\nWorld");
  });

  it("skips an attachment part nested in multipart/mixed", () => {
    const message = makeMessage({
      headers: [{ name: "Subject", value: "Hi" }],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { size: 4, data: encodeBase64Url("body") } }],
        },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { size: 100, data: encodeBase64Url("ignored") },
        },
      ],
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.body).toBe("body");
  });

  it("uses the top-level body for a non-multipart message", () => {
    const message: GmailMessage = {
      id: "m1",
      threadId: "m1",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "Hi" }],
        body: { size: 5, data: encodeBase64Url("plain") },
      },
    };
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.body).toBe("plain");
  });

  it("truncates the body to maxChars", () => {
    const message = makeMessage({ headers: [], text: "0123456789" });
    const state = buildState(message, { selfAddress, maxChars: 5 });
    expect(state.body).toBe("01234");
  });

  it("is true when the self address is in To", () => {
    const message = makeMessage({
      headers: [{ name: "To", value: "Me <ME@example.com>, other@example.com" }],
      text: "x",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.to_me_directly).toBe(true);
  });

  it("matches plus-addressed, dotted, and googlemail variants of the self address", () => {
    const variants = ["me+shop@gmail.com", "m.e@gmail.com", "me@googlemail.com"];
    for (const variant of variants) {
      const message = makeMessage({ headers: [{ name: "To", value: variant }], text: "x" });
      const state = buildState(message, { selfAddress: "me@gmail.com", maxChars: 8000 });
      expect(state.to_me_directly).toBe(true);
    }
  });

  it("does not match a different address or a dotted local part outside Gmail", () => {
    const others = ["someone@gmail.com", "m.e@example.com"];
    for (const other of others) {
      const message = makeMessage({ headers: [{ name: "To", value: other }], text: "x" });
      const selfForDomain = other.endsWith("@gmail.com") ? "me@gmail.com" : "me@example.com";
      const state = buildState(message, { selfAddress: selfForDomain, maxChars: 8000 });
      expect(state.to_me_directly).toBe(false);
    }
  });

  it("is false when the self address is only in Cc", () => {
    const message = makeMessage({
      headers: [
        { name: "To", value: "other@example.com" },
        { name: "Cc", value: "me@example.com" },
      ],
      text: "x",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.to_me_directly).toBe(false);
  });

  it("extracts the gmail category from labelIds", () => {
    const message = makeMessage({
      headers: [],
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"],
      text: "x",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.gmail_category).toBe("CATEGORY_PROMOTIONS");
  });

  it("reads bulk signals from headers", () => {
    const message = makeMessage({
      headers: [
        { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
        { name: "Precedence", value: "Bulk" },
        { name: "Auto-Submitted", value: "Auto-Generated" },
      ],
      text: "x",
    });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.bulk_signals).toEqual({
      list_unsubscribe: true,
      precedence: "bulk",
      auto_submitted: "auto-generated",
    });
  });

  it("yields nulls and false when headers are absent", () => {
    const message = makeMessage({ headers: [], text: "x" });
    const state = buildState(message, { selfAddress, maxChars: 8000 });
    expect(state.subject).toBe("");
    expect(state.from).toEqual({ name: null, address: null, domain: null });
    expect(state.to_me_directly).toBe(false);
    expect(state.gmail_category).toBeNull();
    expect(state.bulk_signals).toEqual({
      list_unsubscribe: false,
      precedence: null,
      auto_submitted: null,
    });
  });
});

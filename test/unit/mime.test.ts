import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  getHeader,
  htmlToText,
  parseAddress,
  parseAddressList,
} from "../../src/core/mime";
import { encodeBase64Url } from "../helpers/gmail-fixtures";

describe("decodeBase64Url", () => {
  it("round-trips ASCII text that needs no padding", () => {
    const encoded = encodeBase64Url("hello world");
    expect(decodeBase64Url(encoded)).toBe("hello world");
  });

  it("round-trips text whose base64 form needs padding", () => {
    const encoded = encodeBase64Url("a");
    expect(decodeBase64Url(encoded)).toBe("a");
  });

  it("round-trips multibyte UTF-8 text (Japanese and emoji)", () => {
    const text = "こんにちは、世界🎉";
    const encoded = encodeBase64Url(text);
    expect(decodeBase64Url(encoded)).toBe(text);
  });

  it("accepts explicit padding", () => {
    expect(decodeBase64Url("YQ==")).toBe("a");
    expect(decodeBase64Url("YWI=")).toBe("ab");
  });

  it("accepts line-wrapped data", () => {
    const text = "x".repeat(14);
    const wrapped = encodeBase64Url(text).replace(/(.{16})/, "$1\r\n");
    expect(decodeBase64Url(wrapped)).toBe(text);
    expect(decodeBase64Url("YQ==\n")).toBe("a");
  });
});

describe("getHeader", () => {
  const headers = [
    { name: "Subject", value: "Hi" },
    { name: "X-Custom", value: "v" },
  ];

  it("looks up case-insensitively", () => {
    expect(getHeader(headers, "subject")).toBe("Hi");
    expect(getHeader(headers, "SUBJECT")).toBe("Hi");
  });

  it("returns null for a missing header", () => {
    expect(getHeader(headers, "To")).toBeNull();
  });

  it("returns null when headers is undefined", () => {
    expect(getHeader(undefined, "Subject")).toBeNull();
  });
});

describe("parseAddress", () => {
  it('parses "Name" <addr>', () => {
    expect(parseAddress('"Jane Doe" <Jane@Example.com>')).toEqual({
      name: "Jane Doe",
      address: "jane@example.com",
      domain: "example.com",
    });
  });

  it("parses Name <addr> without quotes", () => {
    expect(parseAddress("Jane Doe <jane@example.com>")).toEqual({
      name: "Jane Doe",
      address: "jane@example.com",
      domain: "example.com",
    });
  });

  it("parses a bare address", () => {
    expect(parseAddress("jane@example.com")).toEqual({
      name: null,
      address: "jane@example.com",
      domain: "example.com",
    });
  });

  it("keeps a comma inside a quoted name intact", () => {
    expect(parseAddress('"Doe, Jane" <jane@example.com>')).toEqual({
      name: "Doe, Jane",
      address: "jane@example.com",
      domain: "example.com",
    });
  });
});

describe("parseAddressList", () => {
  it("splits on commas outside quoted names", () => {
    const list = parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com');
    expect(list).toEqual(["jane@example.com", "bob@example.com"]);
  });
});

describe("htmlToText", () => {
  it("drops script and style blocks", () => {
    const html =
      "<html><head><style>p{color:red}</style></head>" +
      "<body><script>alert(1)</script><p>Hello</p></body></html>";
    expect(htmlToText(html)).toBe("Hello");
  });

  it("breaks lines on block-level closing tags", () => {
    const html = "<p>Line one</p><p>Line two</p><div>Line three</div>";
    expect(htmlToText(html)).toBe("Line one\nLine two\nLine three");
  });

  it("decodes named and numeric entities", () => {
    const html = "<p>Tom &amp; Jerry &lt;3 &#39;quoted&#39; &#x2764;</p>";
    expect(htmlToText(html)).toBe("Tom & Jerry <3 'quoted' ❤");
  });

  it("keeps malformed numeric entities as written", () => {
    expect(htmlToText("<p>Price &#99999999; each</p>")).toBe("Price &#99999999; each");
    expect(htmlToText("<p>&#x110000;</p>")).toBe("&#x110000;");
    expect(htmlToText("<p>&#xD800;</p>")).toBe("&#xD800;");
  });

  it("separates table cells", () => {
    const html = "<table><tr><td>Order</td><td>12345</td></tr></table>";
    expect(htmlToText(html)).toBe("Order 12345");
  });

  it("collapses runs of whitespace and excess blank lines", () => {
    const html = "<p>Too    much   space</p>\n\n\n\n<p>Next</p>";
    expect(htmlToText(html)).toBe("Too much space\n\nNext");
  });
});

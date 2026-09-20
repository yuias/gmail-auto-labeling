import { describe, expect, it } from "vitest";
import { toCsvLine } from "../../scripts/lib/csv";

describe("toCsvLine", () => {
  it("leaves plain fields unquoted", () => {
    expect(toCsvLine(["a", "b", 1, true])).toBe("a,b,1,true");
  });

  it("quotes a field containing a comma", () => {
    expect(toCsvLine(["a,b", "c"])).toBe('"a,b",c');
  });

  it("quotes a field containing a double quote and doubles it", () => {
    expect(toCsvLine(['say "hi"'])).toBe('"say ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsvLine(["line1\nline2"])).toBe('"line1\nline2"');
  });

  it("quotes a field containing a carriage return", () => {
    expect(toCsvLine(["line1\r\nline2"])).toBe('"line1\r\nline2"');
  });

  it("renders null and undefined as empty fields", () => {
    expect(toCsvLine(["a", null, undefined, "b"])).toBe("a,,,b");
  });

  it("joins fields with a comma and applies no trailing terminator", () => {
    expect(toCsvLine(["x", "y"])).toBe("x,y");
  });
});

import { describe, expect, it } from "vitest";
import { createJevCaller } from "../../src/core/jev-sdk";

describe("createJevCaller", () => {
  it("loads @typesafe-ai/sdk under workerd and exposes a systemOne function", () => {
    const caller = createJevCaller("dummy");
    expect(typeof caller.systemOne).toBe("function");
  });
});

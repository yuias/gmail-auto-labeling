import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker routing", () => {
  it("GET /healthz returns 200", async () => {
    const response = await SELF.fetch("http://x/healthz");
    expect(response.status).toBe(200);
  });

  it("unknown routes return 404", async () => {
    const response = await SELF.fetch("http://x/nope");
    expect(response.status).toBe(404);
  });
});

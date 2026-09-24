import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("fetch", () => {
  it("refuses requests that did not come through Cloudflare Access", async () => {
    for (const path of ["/", "/api/status", "/api/health", "/app.js"]) {
      const response = await exports.default.fetch(`https://ops.candlestack.tech${path}`);
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("refuses a forged Access header", async () => {
    const response = await exports.default.fetch("https://ops.candlestack.tech/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "e30.e30.e30" },
    });
    expect(response.status).toBe(403);
  });
});

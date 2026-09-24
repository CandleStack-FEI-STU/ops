import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Test values for the secrets wrangler.jsonc requires.
process.env.ACCESS_CLIENT_ID = "test-client-id";
process.env.ACCESS_CLIENT_SECRET = "test-client-secret";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.local.jsonc" },
      miniflare: { bindings: { OPERATOR_TOKEN: "test-operator-token-only" } },
    }),
  ],
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@lark-opdev/block-bitable-api": new URL("./tests/sdk-stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    coverage: { enabled: false },
  },
});

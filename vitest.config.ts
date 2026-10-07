import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: { enabled: false },
    env: { BUSINESS_PROFILE_FILE: "tests/fixtures/business-profile.json" },
    maxWorkers: 2,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/test/**/*.test.ts",
      "src/ws/http/routes/__tests__/**/*.test.ts",
      "src/scheduler/**/*.test.ts",
      "src/swarm/__tests__/**/*.test.ts",
      "src/swarm/specialists/__tests__/**/*.test.ts",
      "src/telemetry/__tests__/**/*.test.ts",
      "src/terminal/__tests__/**/*.test.ts",
      "src/utils/__tests__/**/*.test.ts",
      "src/versioning/__tests__/**/*.test.ts",
      "../../scripts/__tests__/**/*.test.mjs"
    ],
    globals: true
  }
});

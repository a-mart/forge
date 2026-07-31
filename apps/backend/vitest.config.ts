import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@forge/protocol": resolve(__dirname, "../../packages/protocol/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/test/**/*.test.ts",
      "src/ws/http/routes/__tests__/**/*.test.ts",
      "src/ws/__tests__/**/*.test.ts",
      "src/scheduler/**/*.test.ts",
      "src/swarm/__tests__/**/*.test.ts",
      "src/swarm/remote-update-awareness/__tests__/**/*.test.ts",
      "src/swarm/specialists/__tests__/**/*.test.ts",
      "src/observability/__tests__/**/*.test.ts",
      "src/telemetry/__tests__/**/*.test.ts",
      "src/terminal/__tests__/**/*.test.ts",
      "src/utils/__tests__/**/*.test.ts",
      "src/versioning/__tests__/**/*.test.ts",
      "src/__tests__/**/*.test.ts",
      "../../scripts/__tests__/**/*.test.mjs"
    ],
    globals: true,
    setupFiles: [resolve(__dirname, "src/test-support/vitest-test-environment.ts")],
  }
});

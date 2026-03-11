import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts", "src/swarm/__tests__/**/*.test.ts", "../../scripts/__tests__/**/*.test.mjs"],
    globals: true
  }
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pi's Anthropic OAuth path identifies as Claude Code, and Anthropic gates newer
// models on that version. Keep it equal to the Claude Code version bundled for
// Claude native so updating the native runtime cannot leave Pi requests behind.
describe("Anthropic OAuth client version", () => {
  it("matches the bundled Claude native runtime", () => {
    const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const piMessages = readFileSync(join(backendRoot, "node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js"), "utf8");
    const sdkPackage = join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    const { claudeCodeVersion } = JSON.parse(readFileSync(sdkPackage, "utf8")) as { claudeCodeVersion: string };
    expect(/const claudeCodeVersion = "([^"]+)";/.exec(piMessages)?.[1]).toBe(claudeCodeVersion);
  });
});

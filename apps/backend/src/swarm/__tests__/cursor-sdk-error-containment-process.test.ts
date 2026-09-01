import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(fixtureDir, "fixtures", "cursor-sdk-error-containment-child.ts");

type ChildResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

// Node 26 emits this exact runtime deprecation while loading the current Cursor
// SDK dependency. Keep child stderr strict: only this known Node diagnostic is
// portable noise, and every other byte remains assertion-visible.
const NODE_26_CURSOR_SDK_REGISTER_DEPRECATION =
  /^\(node:\d+\) \[DEP0205\] DeprecationWarning: `module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.\r?\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)\r?\n?/gm;

function withoutKnownCursorSdkNode26Warning(stderr: string): string {
  return stderr.replace(NODE_26_CURSOR_SDK_REGISTER_DEPRECATION, "");
}

async function runScenario(scenario: string): Promise<ChildResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", "tsx", fixturePath, scenario], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: undefined }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("Cursor SDK containment child process behavior", () => {
  it("filters only the known Node 26 module.register deprecation", () => {
    const warning = "(node:12345) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n" +
      "(Use `node --trace-deprecation ...` to show where the warning was created)\n";
    expect(withoutKnownCursorSdkNode26Warning(warning)).toBe("");
    expect(withoutKnownCursorSdkNode26Warning(`${warning}unexpected stderr\n`)).toBe("unexpected stderr\n");
    expect(withoutKnownCursorSdkNode26Warning("(node:12345) [DEP0205] DeprecationWarning: different detail\n")).toContain("different detail");
  });

  it.each([
    { scenario: "contained-transient", expectedBucket: "retryable_transport" },
    { scenario: "contained-auth", expectedBucket: "auth_permission" }
  ])("contains %s and exits cleanly", async ({ scenario, expectedBucket }) => {
    const result = await runScenario(scenario);

    expect(result.status).toBe(0);
    expect(withoutKnownCursorSdkNode26Warning(result.stderr)).toBe("");
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      marker: "contained",
      bucket: expectedBucket,
      contain: true,
      fatal: false
    });
  });

  it.each([
    "fatal-protocol",
    "fatal-no-scope",
    "fatal-multi-active",
    "fatal-tombstone-ambiguous",
    "fatal-retry-lineage-tombstone-ambiguous",
    "fatal-generic-stream",
    "fatal-generic-cursor-stack",
    "fatal-h2-app-refused-stream",
    "fatal-h2-app-protocol-error",
    "fatal-generic-authentication-error",
    "fatal-generic-agent-busy",
    "fatal-generic-network-error",
    "fatal-code16-unauth-no-provenance",
    "fatal-connect-unknown-provenance",
    "fatal-connect-app-unavailable",
    "fatal-plain-text-refused-stream",
    "fatal-cursor-stack-unavailable",
    "fatal-cursor-stack-unauthenticated",
    "fatal-plain-text-unavailable",
    "fatal-plain-text-enhance-your-calm",
    "fatal-ordinary-uncaught"
  ])("fails closed for %s", async (scenario) => {
    const result = await runScenario(scenario);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("unexpected-survival");
  });
});

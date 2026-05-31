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

async function runScenario(scenario: string): Promise<ChildResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", "tsx", fixturePath, scenario], {
      stdio: ["ignore", "pipe", "pipe"]
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
  it.each([
    { scenario: "contained-transient", expectedBucket: "retryable_transport" },
    { scenario: "contained-auth", expectedBucket: "auth_permission" }
  ])("contains %s and exits cleanly", async ({ scenario, expectedBucket }) => {
    const result = await runScenario(scenario);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
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
    "fatal-plain-text-refused-stream",
    "fatal-plain-text-unavailable",
    "fatal-plain-text-enhance-your-calm",
    "fatal-ordinary-uncaught"
  ])("fails closed for %s", async (scenario) => {
    const result = await runScenario(scenario);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("unexpected-survival");
  });
});

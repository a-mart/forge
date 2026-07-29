import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HELPER_PATH = fileURLToPath(
  new URL(
    "../secure-sessions/execution/forge-env-askpass",
    import.meta.url,
  ),
);

describe("secure runner environment askpass bridge", () => {
  it("is stored as an LF-only executable script without a byte-order mark", () => {
    const bytes = readFileSync(HELPER_PATH);

    expect(bytes.subarray(0, 10).toString("hex")).toBe(
      "23212f62696e2f73680a",
    );
    expect(bytes.includes(0x0d)).toBe(false);
  });

  it("returns only the selected authorized environment value", () => {
    const result = spawnSync(
      "/bin/sh",
      [HELPER_PATH, "Password:"],
      {
        encoding: "utf8",
        env: {
          FORGE_ASKPASS_ENV: "FORGE_SECRET_SSH_PASSWORD_A1B2",
          FORGE_SECRET_SSH_PASSWORD_A1B2: "ssh-canary-value",
          UNRELATED_SECRET: "must-not-be-returned",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ssh-canary-value\n");
    expect(result.stdout).not.toContain("must-not-be-returned");
    expect(result.stderr).toBe("");
  });

  it.each([
    undefined,
    "",
    "9INVALID",
    "INVALID-NAME",
    "NAME;printenv",
  ])("rejects an invalid selector without output: %s", (selector) => {
    const result = spawnSync(
      "/bin/sh",
      [HELPER_PATH, "Password:"],
      {
        encoding: "utf8",
        env: {
          ...(selector === undefined ? {} : { FORGE_ASKPASS_ENV: selector }),
          FORGE_SECRET_VALID: "must-not-be-returned",
        },
      },
    );

    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("fails without output when the selected variable is absent", () => {
    const result = spawnSync(
      "/bin/sh",
      [HELPER_PATH, "Password:"],
      {
        encoding: "utf8",
        env: { FORGE_ASKPASS_ENV: "FORGE_SECRET_MISSING" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

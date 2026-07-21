import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCli, normalizeGitCommandError } from "../git-cli.js";

async function executable(name: string, body: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "remote-awareness-cli-"));
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return { dir, path };
}

describe("GitCli remote update controls", () => {
  it("applies the noninteractive environment per call without mutating process.env", async () => {
    const script = await executable("env.sh", "printf '%s|%s|%s' \"$GIT_TERMINAL_PROMPT\" \"$GCM_INTERACTIVE\" \"$CUSTOM_VALUE\"");
    const original = process.env.GIT_TERMINAL_PROMPT;
    const git = new GitCli({ cwd: script.dir, gitBinary: script.path });
    const result = await git.run([], { nonInteractive: true, env: { CUSTOM_VALUE: "per-call" } });
    expect(result.stdout).toBe("0|Never|per-call");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe(original);
  });

  it("supports AbortSignal and returns a typed allowFailure cancellation", async () => {
    const script = await executable("slow.sh", "sleep 5");
    const git = new GitCli({ cwd: script.dir, gitBinary: script.path });
    const controller = new AbortController();
    const pending = git.run([], { allowFailure: true, signal: controller.signal, timeoutMs: 10_000 });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(normalizeGitCommandError([], result).classification).toBe("aborted");
  });

  it("enforces a per-call bounded output cap", async () => {
    const script = await executable("loud.sh", "i=0; while [ $i -lt 1000 ]; do printf '0123456789' >&2; i=$((i+1)); done; exit 2");
    const git = new GitCli({ cwd: script.dir, gitBinary: script.path });
    const result = await git.run([], { allowFailure: true, maxBufferBytes: 128 });
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);
    expect(result.exitCode).not.toBe(0);
  });

  it("keeps timeout and abort messages free of arguments", async () => {
    const script = await executable("slow-secret.sh", "sleep 5");
    const git = new GitCli({ cwd: script.dir, gitBinary: script.path });
    const secretArg = "https://user:token@example.test/repo.git";
    const result = await git.run([secretArg], { allowFailure: true, timeoutMs: 20, nonInteractive: true });
    expect(normalizeGitCommandError(["fetch"], result).classification).toBe("timeout");
    expect(result.stderr).not.toContain(secretArg);
  });
});

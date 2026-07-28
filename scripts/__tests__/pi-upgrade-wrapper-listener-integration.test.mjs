/**
 * Integration tests for the actual isolated-instance launcher and stopper.
 *
 * A disposable fake pnpm executable supplies tiny HTTP listeners so these tests
 * exercise the production shell ownership/nonce/data-dir checks without
 * starting the full backend or UI.
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..", "..");
const startScript = join(repoRoot, "scripts/pi-upgrade/start-isolated-instance.sh");
const stopScript = join(repoRoot, "scripts/pi-upgrade/stop-isolated-instance.sh");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function command(file, args, options) {
  try {
    return await execFileAsync(file, args, options);
  } catch (error) {
    return { ...error, failed: true, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for isolated instance state");
}

describe("pi-upgrade isolated instance ownership integration", () => {
  it("runs the real start/stop scripts and refuses a nonce-mismatched listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-real-scripts-"));
    const home = join(root, "home");
    const tempDir = join(root, "tmp");
    const dataDir = join(root, "data");
    const scriptRoot = join(root, "repo");
    const fakeBin = join(home, "Library/pnpm");
    const backendPort = await freePort();
    const uiPort = await freePort();
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: tempDir,
      FORGE_PORT: String(backendPort),
      FORGE_UI_PORT: String(uiPort),
      FORGE_DATA_DIR: dataDir,
      VITE_FORGE_WS_URL: `ws://127.0.0.1:${backendPort}`,
    };
    await mkdir(join(scriptRoot, "scripts/pi-upgrade"), { recursive: true });
    await mkdir(join(dataDir, "shared/config/auth"), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(dataDir, "shared/config/auth/auth.json"), "{}\n", { mode: 0o600 });
    await writeFile(join(scriptRoot, ".env"), `FORGE_DATA_DIR=${dataDir}\nFORGE_PORT=${backendPort}\nFORGE_UI_PORT=${uiPort}\nVITE_FORGE_WS_URL=ws://127.0.0.1:${backendPort}\n`);
    await cp(startScript, join(scriptRoot, "scripts/pi-upgrade/start-isolated-instance.sh"));
    await cp(stopScript, join(scriptRoot, "scripts/pi-upgrade/stop-isolated-instance.sh"));
    await cp(join(repoRoot, "scripts/pi-upgrade/assert-isolation.mjs"), join(scriptRoot, "scripts/pi-upgrade/assert-isolation.mjs"));

    const listener = join(root, "listener.mjs");
    await writeFile(listener, `
      import { createServer } from "node:http";
      const port = Number(process.env.FORGE_FAKE_PORT);
      const server = createServer((_request, response) => { response.writeHead(200); response.end("ok"); });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `);
    const fakePnpm = join(fakeBin, "pnpm");
    await writeFile(fakePnpm, `#!/bin/sh
      if printf '%s' "$*" | grep -q '@forge/backend'; then
        FORGE_FAKE_PORT="$FORGE_PORT" node "$FORGE_FAKE_LISTENER" &
      else
        FORGE_FAKE_PORT="$FORGE_UI_PORT" node "$FORGE_FAKE_LISTENER" &
      fi
      child=$!
      trap 'kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0' TERM INT
      wait "$child"
    `, { mode: 0o755 });
    // The copied start script resolves its root from the temporary script tree.
    env.FORGE_FAKE_LISTENER = listener;

    const logDir = join(tempDir, "forge-pi-upgrade-isolated");
    try {
      const started = await command("bash", [join(scriptRoot, "scripts/pi-upgrade/start-isolated-instance.sh")], { cwd: scriptRoot, env });
      expect(started.failed, `${started.stdout}\n${started.stderr}`).toBeFalsy();
      expect(started.stdout).toContain("Isolated instance ready");

      const backendPidFile = join(logDir, `backend-${backendPort}.pid`);
      const wrapperPidFile = join(logDir, `backend-${backendPort}.wrapper.pid`);
      const nonceFile = join(logDir, `backend-${backendPort}.nonce`);
      const listenerPid = (await readFile(backendPidFile, "utf8")).trim();
      const wrapperPid = (await readFile(wrapperPidFile, "utf8")).trim();
      const nonce = (await readFile(nonceFile, "utf8")).trim();
      expect(listenerPid).toMatch(/^\d+$/);
      expect(wrapperPid).toMatch(/^\d+$/);
      expect(listenerPid).not.toBe(wrapperPid);
      expect(nonce).toMatch(/^[0-9a-f-]{36}$/u);

      const refused = await command("bash", [join(scriptRoot, "scripts/pi-upgrade/start-isolated-instance.sh")], { cwd: scriptRoot, env });
      expect(refused.failed).toBe(true);
      expect(refused.stderr).toMatch(/already in use/u);

      await writeFile(nonceFile, "wrong-nonce\n");
      const rejectedStop = await command("bash", [join(scriptRoot, "scripts/pi-upgrade/stop-isolated-instance.sh")], { cwd: scriptRoot, env });
      expect(rejectedStop.failed).toBe(true);
      expect(rejectedStop.stderr).toMatch(/nonce mismatch/u);
      expect((await readFile(backendPidFile, "utf8")).trim()).toBe(listenerPid);

      await writeFile(nonceFile, `${nonce}\n`);
      const stopped = await command("bash", [join(scriptRoot, "scripts/pi-upgrade/stop-isolated-instance.sh")], { cwd: scriptRoot, env });
      expect(stopped.failed, `${stopped.stdout}\n${stopped.stderr}`).toBeFalsy();
      await waitFor(async () => {
        const probe = await command("lsof", ["-i", `:${backendPort}`, "-sTCP:LISTEN", "-t"]);
        return probe.stdout.trim() === "";
      });
      await expect(readFile(backendPidFile, "utf8")).rejects.toThrow();
    } finally {
      // Best effort cleanup if an assertion fails before the normal stop.
      await command("bash", [join(scriptRoot, "scripts/pi-upgrade/stop-isolated-instance.sh")], { cwd: scriptRoot, env });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

#!/usr/bin/env node
/**
 * Integration test: pnpm-like wrapper vs actual TCP listener ownership.
 * Spawns a wrapper that launches a child listener, validates ancestry/nonce
 * recording semantics used by start/stop-isolated-instance.sh.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function readPpid(pid) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const ppid = Number(String(result.stdout || "").replace(/\D/g, ""));
  return Number.isFinite(ppid) ? ppid : null;
}

function isDescendantOf(childPid, ancestorPid) {
  let current = childPid;
  for (let i = 0; i < 64; i++) {
    if (current === ancestorPid) return true;
    const ppid = readPpid(current);
    if (ppid == null) return false;
    current = ppid;
    if (current === 0 || current === 1) return false;
  }
  return false;
}

describe("pi-upgrade wrapper/listener ownership integration", () => {
  it("records the actual listener PID under a pnpm-like wrapper ancestry with nonce", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-isolation-"));
    const port = await getFreePort();
    const nonce = `nonce-${Date.now()}`;
    const dataDir = join(root, "data");
    const logDir = join(root, "logs");
    await mkdir(dataDir, { recursive: true });
    await mkdir(logDir, { recursive: true });

    const listenerScript = join(root, "listener.mjs");
    await writeFile(
      listenerScript,
      `
import { createServer } from 'node:net';
const server = createServer();
server.listen(${port}, '127.0.0.1', () => {
  process.stdout.write('listening\\n');
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const wrapperScript = join(root, "wrapper.mjs");
    await writeFile(
      wrapperScript,
      `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(listenerScript)}], {
  env: {
    ...process.env,
    FORGE_PI_UPGRADE_INSTANCE_NONCE: ${JSON.stringify(nonce)},
    FORGE_DATA_DIR: ${JSON.stringify(dataDir)},
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const wrapper = spawn(process.execPath, [wrapperScript], {
      env: {
        ...process.env,
        FORGE_PI_UPGRADE_INSTANCE_NONCE: nonce,
        FORGE_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      let listenerPid = null;
      for (let i = 0; i < 50; i++) {
        const result = spawnSync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
        const pids = String(result.stdout || "")
          .trim()
          .split(/\s+/)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (pids.length > 0) {
          listenerPid = pids[0];
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(listenerPid, "listener must bind").toBeTruthy();
      expect(listenerPid).not.toBe(wrapper.pid);
      expect(isDescendantOf(listenerPid, wrapper.pid)).toBe(true);

      await writeFile(join(logDir, `backend-${port}.pid`), String(listenerPid));
      await writeFile(join(logDir, `backend-${port}.wrapper.pid`), String(wrapper.pid));
      await writeFile(join(logDir, `backend-${port}.nonce`), nonce);

      const recordedListener = Number((await readFile(join(logDir, `backend-${port}.pid`), "utf8")).trim());
      const recordedWrapper = Number((await readFile(join(logDir, `backend-${port}.wrapper.pid`), "utf8")).trim());
      expect(recordedListener).toBe(listenerPid);
      expect(recordedWrapper).toBe(wrapper.pid);
      expect(recordedListener).not.toBe(recordedWrapper);
    } finally {
      wrapper.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(wrapper.pid, 0);
        wrapper.kill("SIGKILL");
      } catch {
        // already exited
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

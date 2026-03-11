#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, resolveProdDaemonIpcPaths } from "./prod-daemon-ipc.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pidFile, restartFile } = resolveProdDaemonIpcPaths(repoRoot);

if (!fs.existsSync(pidFile)) {
  console.error(`[prod-daemon] No daemon pid file found at ${pidFile}. Start it with \`pnpm prod:daemon\`.`);
  process.exit(1);
}

const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error(`[prod-daemon] Invalid pid file: ${pidFile}`);
  process.exit(1);
}

try {
  if (!isPidAlive(pid)) {
    fs.rmSync(pidFile, { force: true });
    console.error(`[prod-daemon] Daemon pid ${pid} is not running. Removed stale pid file.`);
    process.exit(1);
  }

  if (process.platform === "win32") {
    fs.writeFileSync(restartFile, `${Date.now()}\n`, "utf8");
    console.log(`[prod-daemon] Wrote restart request: ${restartFile}`);
  } else {
    process.kill(pid, "SIGUSR1");
    console.log(`[prod-daemon] Sent SIGUSR1 to daemon pid ${pid}.`);
  }
} catch (error) {
  console.error(`[prod-daemon] Failed to signal daemon pid ${pid}: ${error.message}`);
  process.exit(1);
}

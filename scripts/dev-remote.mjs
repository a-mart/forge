#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateDevChild } from "./dev-remote-process-tree.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const pnpmCommand = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
const pnpmArgs = (args) => isWindows ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args;
const forceKillAfterMs = 5_000;
const dryRun = process.argv.includes("--dry-run");

const commonEnv = {
  ...process.env,
  FORGE_HOST: "0.0.0.0",
};

const processes = [
  {
    label: "backend",
    command: pnpmCommand,
    args: pnpmArgs(["--filter", "@forge/backend", "dev"]),
    env: commonEnv,
  },
  {
    label: "ui",
    command: pnpmCommand,
    args: pnpmArgs(["--filter", "@forge/ui", "dev", "--host", "0.0.0.0"]),
    env: {
      ...commonEnv,
      FORGE_DISABLE_TANSTACK_DEVTOOLS: "true",
      VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS: "true",
    },
  },
];

const preflight = {
  label: "preflight",
  command: pnpmCommand,
  args: pnpmArgs(["run", "dev:preflight"]),
  env: commonEnv,
};

if (dryRun) {
  console.log(
    `[dev:remote] ${preflight.label}: ${preflight.command} ${preflight.args.join(" ")}`,
  );
  for (const processConfig of processes) {
    const envSummary = [
      `FORGE_HOST=${processConfig.env.FORGE_HOST}`,
      processConfig.env.FORGE_DISABLE_TANSTACK_DEVTOOLS
        ? `FORGE_DISABLE_TANSTACK_DEVTOOLS=${processConfig.env.FORGE_DISABLE_TANSTACK_DEVTOOLS}`
        : null,
      processConfig.env.VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS
        ? `VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS=${processConfig.env.VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS}`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `[dev:remote] ${processConfig.label}: ${envSummary} ${processConfig.command} ${processConfig.args.join(" ")}`,
    );
  }
  process.exit(0);
}

const preflightResult = spawnSync(preflight.command, preflight.args, {
  cwd: repoRoot,
  env: preflight.env,
  stdio: "inherit",
  windowsHide: false,
});

if (preflightResult.error) {
  console.error(`[dev:remote] Failed to run preflight: ${preflightResult.error.message}`);
  process.exit(1);
}

if (preflightResult.status !== 0) {
  process.exit(preflightResult.status ?? 1);
}

let shuttingDown = false;
let finalExitCode = 0;
const children = new Map();

function prefixStream(label, stream, output) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      output.write(`[${label}] ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      output.write(`[${label}] ${buffer}\n`);
      buffer = "";
    }
  });
}

function killChild(child, signal = "SIGINT") {
  terminateDevChild(child, {
    platform: process.platform,
    signal,
    onError: (error) => {
      console.error(`[dev:remote] Failed to terminate child tree ${child.pid}: ${error.message}`);
    },
  });
}

function forceKillChild(child) {
  terminateDevChild(child, {
    signal: "SIGKILL",
    onError: (error) => {
      console.error(`[dev:remote] Failed to force-kill child ${child.pid}: ${error.message}`);
    },
  });
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  finalExitCode = exitCode;
  for (const child of children.values()) {
    killChild(child);
  }

  // Windows signals only terminate the cmd.exe wrapper, so kill its full tree
  // immediately above. POSIX children keep the graceful timeout before SIGKILL.
  if (!isWindows) {
    setTimeout(() => {
      for (const child of children.values()) {
        forceKillChild(child);
      }
    }, forceKillAfterMs).unref();
  }

  if (children.size === 0) {
    process.exit(finalExitCode);
  }
}

for (const processConfig of processes) {
  const child = spawn(processConfig.command, processConfig.args, {
    cwd: repoRoot,
    env: processConfig.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: !isWindows,
    windowsHide: false,
  });

  children.set(processConfig.label, child);
  prefixStream(processConfig.label, child.stdout, process.stdout);
  prefixStream(processConfig.label, child.stderr, process.stderr);

  child.on("error", (error) => {
    console.error(`[dev:remote] Failed to start ${processConfig.label}: ${error.message}`);
    finalExitCode = 1;
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    children.delete(processConfig.label);
    const childExitCode = code ?? (signal ? 128 : 1);
    console.error(
      `[dev:remote] ${processConfig.label} exited ${code === null ? `from signal ${signal}` : `with code ${code}`}`,
    );

    if (!shuttingDown) {
      shutdown(childExitCode === 0 ? 0 : childExitCode);
      return;
    }

    if (childExitCode !== 0 && finalExitCode === 0) {
      finalExitCode = childExitCode;
    }

    if (children.size === 0) {
      process.exit(finalExitCode);
    }
  });
}

process.on("SIGINT", () => shutdown(130));

if (isWindows) {
  process.on("SIGBREAK", () => shutdown(131));
} else {
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGHUP", () => shutdown(129));
}

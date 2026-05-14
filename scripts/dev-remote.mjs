#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
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
    args: ["--filter", "@forge/backend", "dev"],
    env: commonEnv,
  },
  {
    label: "ui",
    command: pnpmCommand,
    args: ["--filter", "@forge/ui", "dev", "--host", "0.0.0.0"],
    env: {
      ...commonEnv,
      FORGE_DISABLE_TANSTACK_DEVTOOLS: "true",
      VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS: "true",
    },
  },
];

if (dryRun) {
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
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(`[dev:remote] Failed to signal child ${child.pid}: ${error.message}`);
    }
  }
}

function forceKillChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error(`[dev:remote] Failed to force-kill child ${child.pid}: ${error.message}`);
    }
  }
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

  setTimeout(() => {
    for (const child of children.values()) {
      forceKillChild(child);
    }
  }, forceKillAfterMs).unref();

  if (children.size === 0) {
    process.exit(finalExitCode);
  }
}

for (const processConfig of processes) {
  const child = spawn(processConfig.command, processConfig.args, {
    cwd: repoRoot,
    env: processConfig.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
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

if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown(131));
} else {
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGHUP", () => shutdown(129));
}

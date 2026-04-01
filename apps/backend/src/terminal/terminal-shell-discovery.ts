import type { AvailableTerminalShell } from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { resolveCommand } from "./terminal-pty-runtime.js";

interface ShellCandidate {
  path: string;
  name: string;
}

export async function discoverAvailableShells(currentDefaultShell?: string): Promise<AvailableTerminalShell[]> {
  const candidates = process.platform === "win32"
    ? buildWindowsShellCandidates(currentDefaultShell)
    : await buildUnixShellCandidates(currentDefaultShell);

  return candidates.map((candidate) => ({
    path: candidate.path,
    name: candidate.name,
    available: Boolean(resolveCommand(candidate.path)),
  }));
}

async function buildUnixShellCandidates(currentDefaultShell?: string): Promise<ShellCandidate[]> {
  const candidates = new Map<string, ShellCandidate>();
  const addCandidate = (path: string, name?: string): void => {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }

    if (!candidates.has(trimmed)) {
      candidates.set(trimmed, {
        path: trimmed,
        name: name ?? humanizeShellName(trimmed),
      });
    }
  };

  for (const candidate of [
    "/bin/bash",
    "/bin/zsh",
    "/bin/sh",
    "/bin/fish",
    "/usr/bin/bash",
    "/usr/bin/zsh",
    "/usr/bin/sh",
    "/usr/bin/fish",
    "/usr/local/bin/bash",
    "/usr/local/bin/zsh",
    "/usr/local/bin/fish",
    "/opt/homebrew/bin/bash",
    "/opt/homebrew/bin/zsh",
    "/opt/homebrew/bin/fish",
  ]) {
    addCandidate(candidate);
  }

  try {
    const shellsFile = await readFile("/etc/shells", "utf8");
    for (const line of shellsFile.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      addCandidate(trimmed);
    }
  } catch (error) {
    if (!isEnoentError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[terminal-shell-discovery] Failed to read /etc/shells: ${message}`);
    }
  }

  if (currentDefaultShell?.trim()) {
    addCandidate(currentDefaultShell);
  }

  return Array.from(candidates.values());
}

function buildWindowsShellCandidates(currentDefaultShell?: string): ShellCandidate[] {
  const candidates = new Map<string, ShellCandidate>();
  const addCandidate = (path: string, name?: string): void => {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (!candidates.has(key)) {
      candidates.set(key, {
        path: trimmed,
        name: name ?? humanizeShellName(trimmed),
      });
    }
  };

  const programFiles = process.env.ProgramFiles?.trim() || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";

  addCandidate("pwsh.exe", "PowerShell");
  addCandidate("powershell.exe", "Windows PowerShell");
  addCandidate("cmd.exe", "Command Prompt");
  addCandidate("wsl.exe", "WSL");
  addCandidate(win32.join(programFiles, "Git", "bin", "bash.exe"), "Git Bash");
  addCandidate(win32.join(programFilesX86, "Git", "bin", "bash.exe"), "Git Bash");

  if (currentDefaultShell?.trim()) {
    addCandidate(currentDefaultShell);
  }

  return Array.from(candidates.values());
}

function humanizeShellName(pathValue: string): string {
  const lowerPath = pathValue.toLowerCase();
  const name = pathValue.split(/[\\/]/u).at(-1)?.toLowerCase() ?? pathValue.toLowerCase();

  if (lowerPath.includes("git") && (name === "bash" || name === "bash.exe")) {
    return "Git Bash";
  }

  switch (name) {
    case "pwsh":
    case "pwsh.exe":
      return "PowerShell";
    case "powershell":
    case "powershell.exe":
      return "Windows PowerShell";
    case "cmd":
    case "cmd.exe":
      return "Command Prompt";
    case "wsl":
    case "wsl.exe":
      return "WSL";
    case "zsh":
      return "Zsh";
    case "bash":
    case "bash.exe":
      return "Bash";
    case "fish":
      return "Fish";
    case "sh":
      return "Bourne Shell";
    case "ksh":
      return "KornShell";
    case "tcsh":
      return "Tcsh";
    case "csh":
      return "C Shell";
    default: {
      const normalized = name.replace(/\.exe$/u, "");
      if (!normalized) {
        return pathValue;
      }
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
  }
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT",
  );
}

/**
 * macOS / Linux GUI PATH Fix
 *
 * When an Electron app is launched from Finder (macOS) or a desktop launcher
 * (Linux), the process does NOT inherit the user's shell PATH. This means
 * tools like `git`, `node`, `codex`, etc. won't be found when the backend
 * spawns agent subprocesses.
 *
 * This module extracts the user's full shell PATH by running their default
 * shell in interactive-login mode and merges it into `process.env.PATH`.
 *
 * On Windows, GUI apps inherit PATH correctly, so this is a no-op.
 *
 * Equivalent to the popular `fix-path` npm package but implemented inline
 * to avoid ESM-only dependency issues in the Electron main process.
 */

import { execFileSync } from 'node:child_process';
import { env, platform } from 'node:process';

// ANSI escape code regex (same as strip-ansi)
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Attempts to read the user's shell PATH by invoking their default shell.
 * Returns the extracted PATH string, or undefined on failure.
 */
function getShellPath(): string | undefined {
  const shell = env.SHELL;
  if (!shell) return undefined;

  try {
    // Use interactive-login mode to source the user's full profile/rc files.
    // `-i` = interactive (sources .bashrc/.zshrc), `-l` = login (sources .profile/.zprofile)
    // `-c` = execute command.
    //
    // For fish shell, the flag syntax differs: fish uses `-c` but doesn't
    // need `-i -l` — an interactive login is the default when fish is invoked
    // as a login shell. We use the same flags regardless; fish ignores `-i`/`-l`
    // gracefully, and we also try the fish-specific `status` approach below.
    const args = shell.endsWith('/fish')
      ? ['-l', '-c', 'echo PATH="$PATH"']
      : ['-ilc', 'echo PATH="$PATH"'];

    const result = execFileSync(shell, args, {
      encoding: 'utf8',
      timeout: 5000, // 5s timeout — should be near-instant
      stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr (motd, etc.)
      env: {
        ...env,
        // Prevent recursive shell config from hanging
        // (e.g., conda init scripts that prompt)
        NO_COLOR: '1',
      },
    });

    // The output may contain MOTD, prompts, or ANSI codes.
    // Find the line that starts with "PATH=" and extract the value.
    const lines = result.split('\n');
    for (const line of lines) {
      const cleaned = line.replace(ANSI_REGEX, '').trim();
      if (cleaned.startsWith('PATH=')) {
        return cleaned.slice(5); // strip "PATH=" prefix
      }
    }

    return undefined;
  } catch {
    // Shell invocation failed — maybe $SHELL is invalid, timed out, etc.
    // Fall through gracefully; the app will use whatever PATH it inherited.
    return undefined;
  }
}

/**
 * Merges shell PATH entries into `process.env.PATH`.
 *
 * De-duplicates entries while preserving order: shell PATH entries come first,
 * followed by any entries from the inherited (GUI) PATH that weren't already
 * present.
 */
function mergePath(shellPath: string, currentPath: string): string {
  const separator = platform === 'win32' ? ';' : ':';
  const shellEntries = shellPath.split(separator).filter(Boolean);
  const currentEntries = currentPath.split(separator).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];

  // Shell PATH entries take priority
  for (const entry of shellEntries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }

  // Append any current entries not already present
  for (const entry of currentEntries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }

  return merged.join(separator);
}

/**
 * Fix the PATH for macOS/Linux GUI-launched Electron apps.
 *
 * Call this once in the main process before forking the backend child.
 * Mutates `process.env.PATH` in place so child processes inherit it.
 *
 * No-op on Windows or if shell PATH extraction fails.
 */
export function fixPath(): void {
  if (platform === 'win32') return;

  const shellPath = getShellPath();
  if (!shellPath) return;

  const currentPath = env.PATH ?? '';
  env.PATH = mergePath(shellPath, currentPath);
}

/**
 * Returns the shell's PATH without modifying `process.env`.
 * Useful if you want to pass a custom env to a child process.
 *
 * Returns undefined on Windows or if extraction fails.
 */
export function getFixedPath(): string | undefined {
  if (platform === 'win32') return undefined;

  const shellPath = getShellPath();
  if (!shellPath) return undefined;

  const currentPath = env.PATH ?? '';
  return mergePath(shellPath, currentPath);
}

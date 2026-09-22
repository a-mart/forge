import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ensureCanonicalAuthFilePath } from "../../auth-storage-paths.js";
import type { SwarmConfig } from "../../types.js";

const execute = promisify(execFile);

/** Resolve the matched native package, including the staged Electron dependency tree. */
export async function resolveClaudeExecutable(env = process.env, platform = process.platform, arch = process.arch): Promise<string> {
  const override = env.CLAUDE_BIN?.trim();
  if (override && (!(platform === "win32" ? win32.isAbsolute(override) : isAbsolute(override)) || /\.(cmd|bat|ps1)$/i.test(override))) {
    throw new Error("CLAUDE_BIN must be an absolute path to the native Claude executable (claude.exe on Windows), not a shell wrapper. Remove CLAUDE_BIN to use Forge's bundled runtime.");
  }
  let executable = override;
  try {
    if (!executable) {
      const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
      const suffix = platform === "linux" && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? "-musl" : "";
      const manifest = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}${suffix}/package.json`);
      executable = join(dirname(manifest), platform === "win32" ? "claude.exe" : "claude");
    }
    await access(executable);
    return executable;
  } catch {
    throw new Error(override
      ? "CLAUDE_BIN does not point to an accessible native Claude executable. Remove it to use Forge's bundled runtime."
      : "Forge's bundled Claude runtime is missing for this platform. Reinstall Forge Desktop, or run pnpm install --frozen-lockfile in the source checkout with optional dependencies enabled.");
  }
}

/** Provider auth is deliberate. Never transfer Pi OAuth or inherit vault/provider secrets. */
export async function claudeRuntimeEnvironment(config: SwarmConfig, source = process.env): Promise<NodeJS.ProcessEnv> {
  const allow = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(source).filter(([key]) => allow.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key)));
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  const mode = source.FORGE_CLAUDE_AUTH_MODE ?? "cli";
  if (mode === "api_key") {
    const credential = AuthStorage.create(await ensureCanonicalAuthFilePath(config)).get("anthropic");
    const key = source.ANTHROPIC_API_KEY?.trim() || (credential?.type === "api_key" ? credential.key : undefined);
    if (!key) throw new Error("Claude native API-key mode requires ANTHROPIC_API_KEY or an Anthropic API key in Forge Authentication settings. Forge's Anthropic OAuth login cannot be used for this mode.");
    env.ANTHROPIC_API_KEY = key;
    if (source.ANTHROPIC_BASE_URL) {
      const base = new URL(source.ANTHROPIC_BASE_URL);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("ANTHROPIC_BASE_URL must be an HTTP(S) URL without embedded credentials.");
      env.ANTHROPIC_BASE_URL = base.href;
    }
  } else if (mode !== "cli") {
    throw new Error("FORGE_CLAUDE_AUTH_MODE must be cli (native Claude login) or api_key (explicit Anthropic API billing).");
  }
  return env;
}

export async function assertClaudeSetup(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
  let version: string;
  try { version = (await execute(executable, ["--version"], { env, timeout: 10_000, windowsHide: true })).stdout.trim(); }
  catch { throw new Error("Claude native could not launch its executable. Check CLAUDE_BIN, file permissions, and the installed platform/architecture. Remove CLAUDE_BIN to use the bundled runtime."); }
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  if (!match) throw new Error("Claude native received an unrecognized version response. Check that CLAUDE_BIN points to Claude Code. Remove CLAUDE_BIN to use Forge's bundled runtime.");
  if (Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 273)))) {
    throw new Error("Claude native requires Claude Code 2.1.273 or newer. Remove CLAUDE_BIN to use Forge's bundled runtime, or update your external installation with: claude update");
  }
  if (env.ANTHROPIC_API_KEY) return;
  const login = process.platform === "win32" ? `& '${executable.replaceAll("'", "''")}' auth login` : `'${executable.replaceAll("'", "'\\''")}' auth login`;
  try {
    const { stdout } = await execute(executable, ["auth", "status", "--json"], { env, timeout: 10_000, windowsHide: true });
    if (JSON.parse(stdout).loggedIn === true) return;
  } catch { /* Present the same actionable, credential-free error for missing/expired login. */ }
  throw new Error(`Claude native needs its own Claude login. Run this in a terminal, then retry the message:\n\n${login}\n\n${env.CLAUDE_CONFIG_DIR ? "Use the same CLAUDE_CONFIG_DIR as Forge. " : ""}The existing Forge Anthropic OAuth login is separate. For explicit API-key billing, set FORGE_CLAUDE_AUTH_MODE=api_key and configure an Anthropic API key.`);
}

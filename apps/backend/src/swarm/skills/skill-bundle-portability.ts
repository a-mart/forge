import { basename, extname } from "node:path";
import type {
  SkillBundleDependencyInfo,
  SkillBundleDependencyManager,
  SkillBundleFileEntry,
  SkillBundleManifestV1,
  SkillBundleOsIndicator,
  SkillBundleScriptInfo,
  SkillBundleScriptKind
} from "@forge/protocol";
import { compareOsIndicators } from "./skill-bundle-canonical.js";
import { compareCodePoint } from "./skill-bundle-paths.js";

const FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FRONTMATTER_KNOWN_FORGE_KEYS = new Set(["name", "description", "env", "envVars"]);
const FRONTMATTER_KNOWN_PI_KEYS = new Set(["name", "description", "env", "envVars"]);

export interface EncodedSkillBundleFileForPortability {
  entry: SkillBundleFileEntry;
  textContent?: string;
}

interface IndicatorPattern {
  token: string;
  regex: RegExp;
  severity: "info" | "warning";
  scriptWarning?: string;
}

const INDICATOR_PATTERNS: IndicatorPattern[] = [
  { token: "brew", regex: /\bbrew\s+(install|update|upgrade)\b/i, severity: "warning", scriptWarning: "Uses macOS Homebrew commands." },
  { token: "apt", regex: /\bapt(-get)?\s+install\b/i, severity: "warning", scriptWarning: "Uses Debian/Ubuntu package manager commands." },
  { token: "yum", regex: /\byum\s+install\b/i, severity: "warning", scriptWarning: "Uses Linux yum package manager commands." },
  { token: "dnf", regex: /\bdnf\s+install\b/i, severity: "warning", scriptWarning: "Uses Linux dnf package manager commands." },
  { token: "pacman", regex: /\bpacman\s+-S\b/i, severity: "warning", scriptWarning: "Uses Arch pacman package manager commands." },
  { token: "choco", regex: /\bchoco\s+install\b/i, severity: "warning", scriptWarning: "Uses Windows Chocolatey commands." },
  { token: "winget", regex: /\bwinget\s+install\b/i, severity: "warning", scriptWarning: "Uses Windows winget commands." },
  { token: "powershell", regex: /\bpowershell(\.exe)?\b/i, severity: "warning", scriptWarning: "Uses PowerShell." },
  { token: "osascript", regex: /\bosascript\b/i, severity: "warning", scriptWarning: "Uses macOS osascript." },
  { token: "open", regex: /(^|[;&|\s])open\s+/im, severity: "info", scriptWarning: "Uses macOS open command." },
  { token: "xdg-open", regex: /\bxdg-open\b/i, severity: "info", scriptWarning: "Uses Linux desktop opener." },
  { token: "xcodebuild", regex: /\bxcodebuild\b/i, severity: "warning", scriptWarning: "Uses Xcode tooling." },
  { token: "npm install", regex: /\bnpm\s+(install|i)\b/i, severity: "warning", scriptWarning: "Runs npm install." },
  { token: "pnpm install", regex: /\bpnpm\s+(install|i)\b/i, severity: "warning", scriptWarning: "Runs pnpm install." },
  { token: "yarn install", regex: /\byarn\s+(install)?\b/i, severity: "warning", scriptWarning: "Runs yarn install." },
  { token: "pip install", regex: /\bpip(3)?\s+install\b/i, severity: "warning", scriptWarning: "Runs pip install." },
  { token: "uv", regex: /\buv\s+(pip\s+)?(add|sync|install)\b/i, severity: "warning", scriptWarning: "Uses uv package tooling." },
  { token: "poetry", regex: /\bpoetry\s+(add|install)\b/i, severity: "warning", scriptWarning: "Uses Poetry package tooling." },
  { token: "cargo", regex: /\bcargo\s+(install|build|run)\b/i, severity: "warning", scriptWarning: "Uses Cargo/Rust tooling." },
  { token: "go install", regex: /\bgo\s+install\b/i, severity: "warning", scriptWarning: "Runs go install." },
  { token: "node-gyp", regex: /\bnode-gyp\b/i, severity: "warning", scriptWarning: "References native node-gyp builds." },
  { token: "sharp", regex: /\bsharp\b/i, severity: "warning", scriptWarning: "References sharp native image dependency." },
  { token: "playwright", regex: /\bplaywright\b/i, severity: "warning", scriptWarning: "References Playwright/browser downloads." },
  { token: "puppeteer", regex: /\bpuppeteer\b/i, severity: "warning", scriptWarning: "References Puppeteer/browser downloads." },
  { token: "curl", regex: /\bcurl\b/i, severity: "warning", scriptWarning: "Performs network downloads with curl." },
  { token: "wget", regex: /\bwget\b/i, severity: "warning", scriptWarning: "Performs network downloads with wget." },
  { token: "Invoke-WebRequest", regex: /\bInvoke-WebRequest\b/i, severity: "warning", scriptWarning: "Performs network downloads with Invoke-WebRequest." },
  { token: "git clone", regex: /\bgit\s+clone\s+https?:\/\//i, severity: "warning", scriptWarning: "Clones from a remote URL." },
  { token: "/Users/", regex: /\/Users\/[A-Za-z0-9._-]+/i, severity: "warning", scriptWarning: "References an absolute macOS user path." },
  { token: "/home/", regex: /\/home\/[A-Za-z0-9._-]+/i, severity: "warning", scriptWarning: "References an absolute Linux home path." },
  { token: "C:\\", regex: /\b[A-Za-z]:\\[^\s'\"]+/i, severity: "warning", scriptWarning: "References a Windows drive path." },
  { token: "~/.", regex: /~\/\.[A-Za-z0-9._/-]*/i, severity: "warning", scriptWarning: "References a hidden file under the user home directory." }
];

const SCRIPT_EXTENSIONS: Record<string, SkillBundleScriptKind> = {
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".ps1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",
  ".js": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".ts": "node",
  ".tsx": "node",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust"
};

const DEPENDENCY_MANIFESTS: Record<string, { manager: SkillBundleDependencyManager; summary: string }> = {
  "package.json": { manager: "npm", summary: "Node package manifest" },
  "package-lock.json": { manager: "npm", summary: "npm lockfile" },
  "pnpm-lock.yaml": { manager: "pnpm", summary: "pnpm lockfile" },
  "yarn.lock": { manager: "yarn", summary: "Yarn lockfile" },
  "requirements.txt": { manager: "pip", summary: "Python pip requirements" },
  "pyproject.toml": { manager: "poetry", summary: "Python project manifest" },
  "uv.lock": { manager: "uv", summary: "uv lockfile" },
  "Cargo.toml": { manager: "cargo", summary: "Rust cargo manifest" },
  "Cargo.lock": { manager: "cargo", summary: "Rust cargo lockfile" },
  "go.mod": { manager: "go", summary: "Go module manifest" },
  "go.sum": { manager: "go", summary: "Go module checksum file" }
};

export function buildPortabilityMetadata(
  files: EncodedSkillBundleFileForPortability[],
  envNames: string[]
): SkillBundleManifestV1["portability"] {
  const osIndicators: SkillBundleOsIndicator[] = [];
  const scripts: SkillBundleScriptInfo[] = [];
  const dependencies: SkillBundleDependencyInfo[] = [];

  for (const file of files) {
    const pathValue = file.entry.path;
    const text = file.textContent;
    if (text === undefined) {
      continue;
    }

    osIndicators.push(...detectOsIndicators(pathValue, text));

    const script = detectScriptInfo(file, envNames);
    if (script) {
      scripts.push(script);
    }

    const dependency = detectDependencyInfo(pathValue, text);
    if (dependency) {
      dependencies.push(dependency);
    }
  }

  return {
    osIndicators: dedupeOsIndicators(osIndicators).sort(compareOsIndicators),
    scripts: scripts.sort((left, right) => compareCodePoint(left.path, right.path)),
    dependencies: dependencies.sort((left, right) => compareCodePoint(left.path, right.path))
  };
}

export function analyzeFrontmatter(markdown: string): SkillBundleManifestV1["skill"]["frontmatter"] {
  const match = FRONTMATTER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return {
      knownForgeKeys: [],
      knownPiKeys: [],
      unsupportedKeys: [],
      warnings: ["SKILL.md has no YAML frontmatter; using directory metadata fallback."]
    };
  }

  const keys = extractTopLevelFrontmatterKeys(match[1]);
  const knownForgeKeys = keys.filter((key) => FRONTMATTER_KNOWN_FORGE_KEYS.has(key)).sort(compareCodePoint);
  const knownPiKeys = keys.filter((key) => FRONTMATTER_KNOWN_PI_KEYS.has(key)).sort(compareCodePoint);
  const unsupportedKeys = keys
    .filter((key) => !FRONTMATTER_KNOWN_FORGE_KEYS.has(key) && !FRONTMATTER_KNOWN_PI_KEYS.has(key))
    .sort(compareCodePoint);
  const warnings = [...unsupportedKeys.map((key) => `Unsupported SKILL.md frontmatter key: ${key}`)];
  if (!keys.includes("name")) {
    warnings.push("SKILL.md frontmatter does not declare a name; using directory metadata fallback.");
  }

  return {
    knownForgeKeys,
    knownPiKeys,
    unsupportedKeys,
    warnings
  };
}

function detectOsIndicators(pathValue: string, text: string): SkillBundleOsIndicator[] {
  const indicators: SkillBundleOsIndicator[] = [];
  for (const pattern of INDICATOR_PATTERNS) {
    if (pattern.regex.test(text)) {
      indicators.push({ path: pathValue, token: pattern.token, severity: pattern.severity });
    }
  }

  return indicators;
}

function detectScriptInfo(file: EncodedSkillBundleFileForPortability, envNames: string[]): SkillBundleScriptInfo | undefined {
  const pathValue = file.entry.path;
  const text = file.textContent;
  if (text === undefined) {
    return undefined;
  }

  const shebang = text.startsWith("#!") ? text.split(/\r?\n/, 1)[0]?.trim() : undefined;
  const kind = detectScriptKind(pathValue, shebang, file.entry.executable === true);
  if (!kind) {
    return undefined;
  }

  const warnings = new Set<string>();
  for (const pattern of INDICATOR_PATTERNS) {
    if (pattern.scriptWarning && pattern.regex.test(text)) {
      warnings.add(pattern.scriptWarning);
    }
  }
  for (const envName of envNames) {
    if (new RegExp(`\\b${escapeRegExp(envName)}\\b`).test(text)) {
      warnings.add(`References environment variable ${envName}; recipient must configure it separately.`);
    }
  }

  return {
    path: pathValue,
    kind,
    ...(shebang ? { shebang } : {}),
    ...(file.entry.executable === true ? { executable: true } : {}),
    warnings: Array.from(warnings).sort(compareCodePoint)
  };
}

function detectScriptKind(pathValue: string, shebang: string | undefined, executable: boolean): SkillBundleScriptKind | undefined {
  const extension = extname(pathValue).toLowerCase();
  const extensionKind = SCRIPT_EXTENSIONS[extension];
  if (extensionKind) {
    return extensionKind;
  }

  if (!shebang) {
    return executable ? "other" : undefined;
  }

  const normalized = shebang.toLowerCase();
  if (/\b(bash|zsh|sh|fish)\b/.test(normalized)) return "shell";
  if (/\bpwsh\b|\bpowershell\b/.test(normalized)) return "powershell";
  if (/\bnode\b|\btsx\b|\bts-node\b/.test(normalized)) return "node";
  if (/\bpython(3)?\b/.test(normalized)) return "python";
  if (/\bruby\b/.test(normalized)) return "ruby";
  if (/\bgo\b/.test(normalized)) return "go";
  if (/\brust\b|\bcargo\b/.test(normalized)) return "rust";
  return "other";
}

function detectDependencyInfo(pathValue: string, text: string): SkillBundleDependencyInfo | undefined {
  const fileName = basename(pathValue);
  const manifest = DEPENDENCY_MANIFESTS[fileName];
  if (!manifest) {
    return undefined;
  }

  const warnings = new Set<string>();
  for (const pattern of INDICATOR_PATTERNS) {
    if (pattern.scriptWarning && pattern.regex.test(text)) {
      warnings.add(pattern.scriptWarning);
    }
  }

  let summary = manifest.summary;
  if (fileName === "package.json") {
    const packageSummary = summarizePackageJson(text, warnings);
    summary = packageSummary ?? summary;
  }

  return {
    path: pathValue,
    manager: manifest.manager,
    summary,
    warnings: Array.from(warnings).sort(compareCodePoint)
  };
}

function summarizePackageJson(text: string, warnings: Set<string>): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const dependencyCount = countObjectKeys(parsed.dependencies) + countObjectKeys(parsed.devDependencies) + countObjectKeys(parsed.optionalDependencies);
    const scriptCount = countObjectKeys(parsed.scripts);
    const dependencyText = dependencyCount === 1 ? "1 dependency" : `${dependencyCount} dependencies`;
    const scriptText = scriptCount === 1 ? "1 script" : `${scriptCount} scripts`;
    return `Node package manifest with ${dependencyText} and ${scriptText}`;
  } catch {
    warnings.add("package.json could not be parsed for dependency summary.");
    return undefined;
  }
}

function extractTopLevelFrontmatterKeys(frontmatter: string): string[] {
  const keys = new Set<string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (key) {
      keys.add(key);
    }
  }

  return Array.from(keys).sort(compareCodePoint);
}

function countObjectKeys(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeOsIndicators(indicators: SkillBundleOsIndicator[]): SkillBundleOsIndicator[] {
  const seen = new Set<string>();
  const deduped: SkillBundleOsIndicator[] = [];
  for (const indicator of indicators) {
    const key = `${indicator.path}\0${indicator.token}\0${indicator.severity}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(indicator);
  }

  return deduped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

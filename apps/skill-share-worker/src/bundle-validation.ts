import type {
  SkillBundleDependencyManager,
  SkillBundleFileEntry,
  SkillBundleManifestV1,
  SkillBundleOsIndicator,
  SkillBundleScriptKind,
  SkillSourceKind
} from "@forge/protocol";

const SKILL_BUNDLE_FORMAT = "forge.skill.bundle.v1";
const SKILL_BUNDLE_VERSION = 1;
const SKILL_FILE_NAME = "SKILL.md";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_RESERVED_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_FORBIDDEN_FILENAME_CHARACTER_PATTERN = /[?*<>|"]/;
const FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const SENSITIVE_ENTRY_NAMES = new Set([
  ".aws",
  ".azure",
  ".config",
  ".docker",
  ".git-credentials",
  ".gnupg",
  ".kube",
  ".netrc",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".ssh",
  ".yarnrc",
  ".yarnrc.yml",
  "auth",
  "auth-secret.key",
  "auth.db",
  "auth.json",
  "client-secret.json",
  "client-secrets.json",
  "client_secret.json",
  "credential-pool.json",
  "credential.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "oauth.json",
  "private-key.json",
  "secrets",
  "secrets.json",
  "service-account.json",
  "service_account.json",
  "token.json",
  "tokens.json"
]);
const SENSITIVE_FILE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);
const FRONTMATTER_KNOWN_KEYS = new Set(["name", "description", "env", "envVars"]);
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

interface BundleValidationLimits {
  maxBundleBytes: number;
  maxFileBytes: number;
  maxFiles: number;
}

interface ParsedEnvDeclaration {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
}

interface DecodedBundleFile {
  file: SkillBundleFileEntry;
  rawBytes: Uint8Array;
  textContent?: string;
}

export interface BundleValidationResult {
  valid: boolean;
  errors: string[];
  contentSha256?: string;
  skillHandle?: string;
  skillName?: string;
  skillDescription?: string;
  originPlatform?: string;
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

export async function validateSkillBundleForStorage(
  candidate: unknown,
  limits: BundleValidationLimits
): Promise<BundleValidationResult> {
  const errors: string[] = [];
  if (!isRecord(candidate)) {
    return { valid: false, errors: ["Skill bundle must be a JSON object."] };
  }

  rejectUnknownKeys(candidate, ["format", "bundleVersion", "createdAt", "contentSha256", "origin", "skill", "portability", "files", "totals"], errors, "Skill bundle");
  if (candidate.format !== SKILL_BUNDLE_FORMAT) errors.push("Unsupported skill bundle format.");
  if (candidate.bundleVersion !== SKILL_BUNDLE_VERSION) errors.push("Unsupported skill bundle version.");
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    errors.push("Skill bundle createdAt must be an ISO timestamp.");
  }
  if (typeof candidate.contentSha256 !== "string" || !SHA256_PATTERN.test(candidate.contentSha256)) {
    errors.push("Skill bundle contentSha256 must be a sha256 hex digest.");
  }

  validateOrigin(candidate.origin, errors);
  validateSkillSummary(candidate.skill, errors);
  validatePortability(candidate.portability, errors);
  const files = await validateFiles(candidate.files, limits, errors);
  validateTotals(candidate.totals, files, limits.maxBundleBytes, errors);
  validateDerivedMetadata(candidate, files, errors);

  let contentSha256: string | undefined;
  if (errors.length === 0) {
    contentSha256 = await computeSkillBundleContentSha256(candidate as unknown as SkillBundleManifestV1);
    if (contentSha256 !== candidate.contentSha256) {
      errors.push("Skill bundle contentSha256 does not match bundle contents.");
    }
  }

  const bundle = candidate as Partial<SkillBundleManifestV1>;
  return {
    valid: errors.length === 0,
    errors,
    ...(contentSha256 ? { contentSha256 } : {}),
    skillHandle: bundle.skill?.handle,
    skillName: bundle.skill?.name,
    skillDescription: bundle.skill?.description,
    originPlatform: bundle.origin?.platform
  };
}

export async function computeSkillBundleContentSha256(bundle: SkillBundleManifestV1): Promise<string> {
  const canonical = canonicalizeBundleForHash(bundle);
  return sha256Hex(TEXT_ENCODER.encode(stableJsonStringify(canonical)));
}

function validateOrigin(origin: unknown, errors: string[]): void {
  if (!isRecord(origin)) {
    errors.push("Skill bundle origin must be an object.");
    return;
  }
  rejectUnknownKeys(origin, ["forgeVersion", "platform", "arch", "osRelease", "skillSourceKind", "profileId"], errors, "Skill bundle origin");
  if (origin.forgeVersion !== undefined && typeof origin.forgeVersion !== "string") errors.push("Skill bundle origin forgeVersion must be a string.");
  if (typeof origin.platform !== "string" || origin.platform.trim().length === 0) errors.push("Skill bundle origin platform is required.");
  if (typeof origin.arch !== "string" || origin.arch.trim().length === 0) errors.push("Skill bundle origin arch is required.");
  if (origin.osRelease !== undefined && typeof origin.osRelease !== "string") errors.push("Skill bundle origin osRelease must be a string.");
  if (!isValidSkillSourceKind(origin.skillSourceKind)) errors.push("Skill bundle origin skillSourceKind is invalid.");
  if (origin.skillSourceKind !== "machine-local" && origin.skillSourceKind !== "profile") {
    errors.push("Skill bundle origin must be a user-created global or project skill.");
  }
  if (origin.skillSourceKind === "profile" && (typeof origin.profileId !== "string" || origin.profileId.trim().length === 0)) {
    errors.push("Profile skill bundles must include origin.profileId.");
  }
  if (origin.skillSourceKind !== "profile" && origin.profileId !== undefined) {
    errors.push("Only profile skill bundles may include origin.profileId.");
  }
}

function validateSkillSummary(skill: unknown, errors: string[]): void {
  if (!isRecord(skill)) {
    errors.push("Skill bundle skill summary must be an object.");
    return;
  }
  rejectUnknownKeys(skill, ["handle", "name", "description", "env", "frontmatter"], errors, "Skill bundle skill summary");
  try {
    assertSafeHandle(skill.handle);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (typeof skill.name !== "string" || skill.name.trim().length === 0) errors.push("Skill bundle skill name is required.");
  if (skill.description !== undefined && typeof skill.description !== "string") errors.push("Skill bundle skill description must be a string.");
  validateSkillEnv(skill.env, errors);
  validateFrontmatterSummary(skill.frontmatter, errors);
}

function validateSkillEnv(envValue: unknown, errors: string[]): void {
  if (!Array.isArray(envValue)) {
    errors.push("Skill bundle env declarations must be an array.");
    return;
  }
  const seenEnv = new Set<string>();
  for (const [index, env] of envValue.entries()) {
    if (!isRecord(env)) {
      errors.push(`Skill env declaration ${index + 1} must be an object.`);
      continue;
    }
    rejectUnknownKeys(env, ["name", "description", "required", "helpUrl"], errors, `Skill env declaration ${index + 1}`);
    if (typeof env.name !== "string" || !ENV_NAME_PATTERN.test(env.name)) {
      errors.push(`Skill env declaration ${index + 1} has an invalid name.`);
    } else if (seenEnv.has(env.name)) {
      errors.push(`Duplicate skill env declaration: ${env.name}.`);
    } else {
      seenEnv.add(env.name);
    }
    if (env.description !== undefined && typeof env.description !== "string") errors.push(`Skill env declaration ${index + 1} description must be a string.`);
    if (typeof env.required !== "boolean") errors.push(`Skill env declaration ${index + 1} required must be a boolean.`);
    if (env.helpUrl !== undefined && typeof env.helpUrl !== "string") errors.push(`Skill env declaration ${index + 1} helpUrl must be a string.`);
  }
}

function validateFrontmatterSummary(frontmatter: unknown, errors: string[]): void {
  if (!isRecord(frontmatter)) {
    errors.push("Skill bundle frontmatter summary must be an object.");
    return;
  }
  rejectUnknownKeys(frontmatter, ["knownForgeKeys", "knownPiKeys", "unsupportedKeys", "warnings"], errors, "Skill bundle frontmatter summary");
  for (const key of ["knownForgeKeys", "knownPiKeys", "unsupportedKeys", "warnings"] as const) {
    if (!Array.isArray(frontmatter[key]) || !frontmatter[key].every((value) => typeof value === "string")) {
      errors.push(`Skill bundle frontmatter ${key} must be a string array.`);
    }
  }
}

function validatePortability(portability: unknown, errors: string[]): void {
  if (!isRecord(portability)) {
    errors.push("Skill bundle portability metadata must be an object.");
    return;
  }
  rejectUnknownKeys(portability, ["osIndicators", "scripts", "dependencies"], errors, "Skill bundle portability metadata");
  validateOsIndicators(portability.osIndicators, errors);
  validateScripts(portability.scripts, errors);
  validateDependencies(portability.dependencies, errors);
}

function validateOsIndicators(osIndicators: unknown, errors: string[]): void {
  if (!Array.isArray(osIndicators)) {
    errors.push("Skill bundle osIndicators must be an array.");
    return;
  }
  for (const [index, indicator] of osIndicators.entries()) {
    if (!isRecord(indicator)) {
      errors.push(`OS indicator ${index + 1} must be an object.`);
      continue;
    }
    rejectUnknownKeys(indicator, ["path", "token", "severity"], errors, `OS indicator ${index + 1}`);
    validateBundlePath(indicator.path, errors, `OS indicator ${index + 1}`);
    if (typeof indicator.token !== "string" || indicator.token.trim().length === 0) errors.push(`OS indicator ${index + 1} token is required.`);
    if (indicator.severity !== "info" && indicator.severity !== "warning") errors.push(`OS indicator ${index + 1} severity is invalid.`);
  }
}

function validateScripts(scripts: unknown, errors: string[]): void {
  if (!Array.isArray(scripts)) {
    errors.push("Skill bundle scripts must be an array.");
    return;
  }
  for (const [index, script] of scripts.entries()) {
    if (!isRecord(script)) {
      errors.push(`Script ${index + 1} must be an object.`);
      continue;
    }
    rejectUnknownKeys(script, ["path", "kind", "shebang", "executable", "warnings"], errors, `Script ${index + 1}`);
    validateBundlePath(script.path, errors, `Script ${index + 1}`);
    if (!isValidScriptKind(script.kind)) errors.push(`Script ${index + 1} kind is invalid.`);
    if (script.shebang !== undefined && typeof script.shebang !== "string") errors.push(`Script ${index + 1} shebang must be a string.`);
    if (script.executable !== undefined && typeof script.executable !== "boolean") errors.push(`Script ${index + 1} executable must be a boolean.`);
    if (!Array.isArray(script.warnings) || !script.warnings.every((value) => typeof value === "string")) errors.push(`Script ${index + 1} warnings must be a string array.`);
  }
}

function validateDependencies(dependencies: unknown, errors: string[]): void {
  if (!Array.isArray(dependencies)) {
    errors.push("Skill bundle dependencies must be an array.");
    return;
  }
  for (const [index, dependency] of dependencies.entries()) {
    if (!isRecord(dependency)) {
      errors.push(`Dependency ${index + 1} must be an object.`);
      continue;
    }
    rejectUnknownKeys(dependency, ["path", "manager", "summary", "warnings"], errors, `Dependency ${index + 1}`);
    validateBundlePath(dependency.path, errors, `Dependency ${index + 1}`);
    if (!isValidDependencyManager(dependency.manager)) errors.push(`Dependency ${index + 1} manager is invalid.`);
    if (typeof dependency.summary !== "string" || dependency.summary.trim().length === 0) errors.push(`Dependency ${index + 1} summary is required.`);
    if (!Array.isArray(dependency.warnings) || !dependency.warnings.every((value) => typeof value === "string")) errors.push(`Dependency ${index + 1} warnings must be a string array.`);
  }
}

async function validateFiles(files: unknown, limits: BundleValidationLimits, errors: string[]): Promise<DecodedBundleFile[]> {
  if (!Array.isArray(files)) {
    errors.push("Skill bundle files must be an array.");
    return [];
  }
  if (files.length === 0) errors.push("Skill bundle must include at least one file.");
  if (files.length > limits.maxFiles) errors.push(`Skill bundle exceeds ${limits.maxFiles} file limit.`);

  const seenPaths = new Set<string>();
  const seenCaseInsensitivePaths = new Map<string, string>();
  const decodedFiles: DecodedBundleFile[] = [];
  let byteCount = 0;
  let hasSkillFile = false;

  for (const [index, value] of files.entries()) {
    if (!isRecord(value)) {
      errors.push(`Bundle file ${index + 1} must be an object.`);
      continue;
    }
    rejectUnknownKeys(value, ["path", "size", "sha256", "encoding", "executable", "content"], errors, `Bundle file ${index + 1}`);

    const pathValue = value.path;
    let normalizedPath: string | undefined;
    if (typeof pathValue !== "string") {
      errors.push(`Bundle file ${index + 1} path is required.`);
    } else {
      normalizedPath = validateBundleFilePath(pathValue, seenPaths, seenCaseInsensitivePaths, errors);
      if (normalizedPath === SKILL_FILE_NAME) hasSkillFile = true;
    }

    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
      errors.push(`Bundle file ${pathValue ?? index + 1} size is invalid.`);
    } else {
      if (value.size > limits.maxFileBytes) errors.push(`Bundle file ${pathValue ?? index + 1} exceeds ${limits.maxFileBytes} byte limit.`);
      byteCount += value.size;
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) errors.push(`Bundle file ${pathValue ?? index + 1} sha256 is invalid.`);
    if (value.encoding !== "utf8" && value.encoding !== "base64") errors.push(`Bundle file ${pathValue ?? index + 1} encoding is invalid.`);
    if (value.executable !== undefined && typeof value.executable !== "boolean") errors.push(`Bundle file ${pathValue ?? index + 1} executable must be a boolean.`);
    if (typeof value.content !== "string") {
      errors.push(`Bundle file ${pathValue ?? index + 1} content must be a string.`);
      continue;
    }

    const rawBytes = decodeFileContent(value.encoding, value.content);
    if (!rawBytes) {
      errors.push(`Bundle file ${pathValue ?? index + 1} content is not valid ${String(value.encoding)}.`);
      continue;
    }
    if (typeof value.size === "number" && rawBytes.byteLength !== value.size) errors.push(`Bundle file ${pathValue ?? index + 1} size does not match decoded content.`);
    if (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256) && await sha256Hex(rawBytes) !== value.sha256) {
      errors.push(`Bundle file ${pathValue ?? index + 1} sha256 does not match decoded content.`);
    }
    if (normalizedPath) decodedFiles.push({ file: value as unknown as SkillBundleFileEntry, rawBytes, ...decodeTextContent(rawBytes) });
  }

  if (!hasSkillFile) errors.push("Skill bundle must include SKILL.md.");
  if (byteCount > limits.maxBundleBytes) errors.push(`Skill bundle exceeds ${limits.maxBundleBytes} byte limit.`);
  return decodedFiles;
}

function validateTotals(totals: unknown, files: DecodedBundleFile[], maxBundleBytes: number, errors: string[]): void {
  if (!isRecord(totals)) {
    errors.push("Skill bundle totals must be an object.");
    return;
  }
  rejectUnknownKeys(totals, ["fileCount", "byteCount"], errors, "Skill bundle totals");
  const byteCount = files.reduce((sum, file) => sum + file.rawBytes.byteLength, 0);
  if (totals.fileCount !== files.length) errors.push("Skill bundle totals.fileCount does not match files.");
  if (totals.byteCount !== byteCount) errors.push("Skill bundle totals.byteCount does not match files.");
  if (typeof totals.byteCount === "number" && totals.byteCount > maxBundleBytes) errors.push(`Skill bundle totals exceed ${maxBundleBytes} byte limit.`);
}

function validateDerivedMetadata(candidate: Record<string, unknown>, files: DecodedBundleFile[], errors: string[]): void {
  if (!isRecord(candidate.skill) || !isRecord(candidate.portability)) return;
  const skillFile = files.find((file) => file.file.path === SKILL_FILE_NAME);
  if (!skillFile) return;
  if (skillFile.textContent === undefined || skillFile.file.encoding !== "utf8") {
    errors.push("SKILL.md must be UTF-8 text.");
    return;
  }

  const handle = typeof candidate.skill.handle === "string" ? candidate.skill.handle : "";
  const parsed = parseSkillFrontmatter(skillFile.textContent);
  const expectedSkill = {
    handle,
    name: (parsed.name ?? handle).trim(),
    ...(parsed.description ? { description: parsed.description } : {}),
    env: parsed.env.map((entry) => ({ ...entry })),
    frontmatter: analyzeFrontmatter(skillFile.textContent)
  };
  if (stableJsonStringify(candidate.skill) !== stableJsonStringify(expectedSkill)) {
    errors.push("Skill bundle skill metadata does not match SKILL.md contents.");
  }

  const expectedPortability = buildPortabilityMetadata(files, parsed.env.map((entry) => entry.name));
  if (stableJsonStringify(candidate.portability) !== stableJsonStringify(expectedPortability)) {
    errors.push("Skill bundle portability metadata does not match decoded file contents.");
  }
}

function parseSkillFrontmatter(markdown: string): { name?: string; description?: string; env: ParsedEnvDeclaration[] } {
  const match = FRONTMATTER_BLOCK_PATTERN.exec(markdown);
  if (!match) return { env: [] };
  const lines = match[1].split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || countLeadingSpaces(line) > 0) continue;
    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) continue;
    if (parsed.key === "name") name = parseYamlStringValue(parsed.value) || undefined;
    if (parsed.key === "description") description = parseYamlStringValue(parsed.value) || undefined;
  }
  return { name, description, env: parseSkillEnvDeclarations(lines) };
}

function parseSkillEnvDeclarations(lines: string[]): ParsedEnvDeclaration[] {
  const envIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "env:" || trimmed === "envVars:";
  });
  if (envIndex < 0) return [];

  const envIndent = countLeadingSpaces(lines[envIndex]);
  const declarations: ParsedEnvDeclaration[] = [];
  let current: Partial<ParsedEnvDeclaration> | undefined;
  const flush = (): void => {
    if (!current) return;
    const normalizedName = typeof current.name === "string" && ENV_NAME_PATTERN.test(current.name.trim()) ? current.name.trim() : undefined;
    if (normalizedName) {
      declarations.push({
        name: normalizedName,
        ...(typeof current.description === "string" && current.description.trim() ? { description: current.description.trim() } : {}),
        required: current.required === true,
        ...(typeof current.helpUrl === "string" && current.helpUrl.trim() ? { helpUrl: current.helpUrl.trim() } : {})
      });
    }
    current = undefined;
  };

  for (let index = envIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (countLeadingSpaces(line) <= envIndent) break;
    if (trimmed.startsWith("-")) {
      flush();
      current = {};
      const inline = trimmed.slice(1).trim();
      const parsedInline = inline ? parseYamlKeyValue(inline) : undefined;
      if (parsedInline) assignEnvField(current, parsedInline.key, parsedInline.value);
      continue;
    }
    if (!current) continue;
    const parsed = parseYamlKeyValue(trimmed);
    if (parsed) assignEnvField(current, parsed.key, parsed.value);
  }
  flush();
  return declarations;
}

function assignEnvField(target: Partial<ParsedEnvDeclaration>, key: string, value: string): void {
  if (key === "name") target.name = parseYamlStringValue(value);
  if (key === "description") target.description = parseYamlStringValue(value);
  if (key === "required") target.required = parseYamlBooleanValue(value) === true;
  if (key === "helpUrl") target.helpUrl = parseYamlStringValue(value);
}

function analyzeFrontmatter(markdown: string): SkillBundleManifestV1["skill"]["frontmatter"] {
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
  const knownKeys = keys.filter((key) => FRONTMATTER_KNOWN_KEYS.has(key)).sort(compareCodePoint);
  const unsupportedKeys = keys.filter((key) => !FRONTMATTER_KNOWN_KEYS.has(key)).sort(compareCodePoint);
  return {
    knownForgeKeys: knownKeys,
    knownPiKeys: knownKeys,
    unsupportedKeys,
    warnings: [
      ...unsupportedKeys.map((key) => `Unsupported SKILL.md frontmatter key: ${key}`),
      ...(!keys.includes("name") ? ["SKILL.md frontmatter does not declare a name; using directory metadata fallback."] : [])
    ]
  };
}

function buildPortabilityMetadata(files: DecodedBundleFile[], envNames: string[]): SkillBundleManifestV1["portability"] {
  const osIndicators: SkillBundleOsIndicator[] = [];
  const scripts: SkillBundleManifestV1["portability"]["scripts"] = [];
  const dependencies: SkillBundleManifestV1["portability"]["dependencies"] = [];
  for (const file of files) {
    if (file.textContent === undefined) continue;
    osIndicators.push(...detectOsIndicators(file.file.path, file.textContent));
    const script = detectScriptInfo(file, envNames);
    if (script) scripts.push(script);
    const dependency = detectDependencyInfo(file.file.path, file.textContent);
    if (dependency) dependencies.push(dependency);
  }
  return {
    osIndicators: dedupeOsIndicators(osIndicators).sort(compareOsIndicators),
    scripts: scripts.sort((left, right) => compareCodePoint(left.path, right.path)),
    dependencies: dependencies.sort((left, right) => compareCodePoint(left.path, right.path))
  };
}

function detectOsIndicators(path: string, text: string): SkillBundleOsIndicator[] {
  return INDICATOR_PATTERNS
    .filter((pattern) => pattern.regex.test(text))
    .map((pattern) => ({ path, token: pattern.token, severity: pattern.severity }));
}

function detectScriptInfo(file: DecodedBundleFile, envNames: string[]): SkillBundleManifestV1["portability"]["scripts"][number] | undefined {
  if (file.textContent === undefined) return undefined;
  const shebang = file.textContent.startsWith("#!") ? file.textContent.split(/\r?\n/, 1)[0]?.trim() : undefined;
  const kind = detectScriptKind(file.file.path, shebang, file.file.executable === true);
  if (!kind) return undefined;
  const warnings = new Set<string>();
  for (const pattern of INDICATOR_PATTERNS) {
    if (pattern.scriptWarning && pattern.regex.test(file.textContent)) warnings.add(pattern.scriptWarning);
  }
  for (const envName of envNames) {
    if (new RegExp(`\\b${escapeRegExp(envName)}\\b`).test(file.textContent)) {
      warnings.add(`References environment variable ${envName}; recipient must configure it separately.`);
    }
  }
  return {
    path: file.file.path,
    kind,
    ...(shebang ? { shebang } : {}),
    ...(file.file.executable === true ? { executable: true } : {}),
    warnings: Array.from(warnings).sort(compareCodePoint)
  };
}

function detectScriptKind(path: string, shebang: string | undefined, executable: boolean): SkillBundleScriptKind | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const extensionKind = SCRIPT_EXTENSIONS[extension];
  if (extensionKind) return extensionKind;
  if (!shebang) return executable ? "other" : undefined;
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

function detectDependencyInfo(path: string, text: string): SkillBundleManifestV1["portability"]["dependencies"][number] | undefined {
  const fileName = path.split("/").at(-1) ?? path;
  const manifest = DEPENDENCY_MANIFESTS[fileName];
  if (!manifest) return undefined;
  const warnings = new Set<string>();
  for (const pattern of INDICATOR_PATTERNS) {
    if (pattern.scriptWarning && pattern.regex.test(text)) warnings.add(pattern.scriptWarning);
  }
  return {
    path,
    manager: manifest.manager,
    summary: fileName === "package.json" ? summarizePackageJson(text, warnings) ?? manifest.summary : manifest.summary,
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

function canonicalizeBundleForHash(bundle: SkillBundleManifestV1): unknown {
  return {
    format: bundle.format,
    bundleVersion: bundle.bundleVersion,
    origin: {
      ...(bundle.origin.forgeVersion ? { forgeVersion: bundle.origin.forgeVersion } : {}),
      platform: bundle.origin.platform,
      arch: bundle.origin.arch,
      ...(bundle.origin.osRelease ? { osRelease: bundle.origin.osRelease } : {}),
      skillSourceKind: bundle.origin.skillSourceKind,
      ...(bundle.origin.profileId ? { profileId: bundle.origin.profileId } : {})
    },
    skill: {
      handle: bundle.skill.handle,
      name: bundle.skill.name,
      ...(bundle.skill.description ? { description: bundle.skill.description } : {}),
      env: bundle.skill.env.map((entry) => ({
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        required: entry.required,
        ...(entry.helpUrl ? { helpUrl: entry.helpUrl } : {})
      })),
      frontmatter: {
        knownForgeKeys: [...bundle.skill.frontmatter.knownForgeKeys].sort(compareCodePoint),
        knownPiKeys: [...bundle.skill.frontmatter.knownPiKeys].sort(compareCodePoint),
        unsupportedKeys: [...bundle.skill.frontmatter.unsupportedKeys].sort(compareCodePoint),
        warnings: [...bundle.skill.frontmatter.warnings]
      }
    },
    portability: {
      osIndicators: [...bundle.portability.osIndicators].sort(compareOsIndicators),
      scripts: [...bundle.portability.scripts].sort((left, right) => compareCodePoint(left.path, right.path)).map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.shebang ? { shebang: entry.shebang } : {}),
        executable: entry.executable === true,
        warnings: [...entry.warnings]
      })),
      dependencies: [...bundle.portability.dependencies].sort((left, right) => compareCodePoint(left.path, right.path))
    },
    files: [...bundle.files].sort((left, right) => compareCodePoint(left.path, right.path)).map((entry) => ({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      encoding: entry.encoding,
      executable: entry.executable === true,
      content: entry.content
    })),
    totals: { fileCount: bundle.totals.fileCount, byteCount: bundle.totals.byteCount }
  };
}

function validateBundlePath(path: unknown, errors: string[], label: string): string | undefined {
  if (typeof path !== "string") {
    errors.push(`${label} path is required.`);
    return undefined;
  }
  try {
    return normalizeBundlePath(path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function validateBundleFilePath(path: string, seenPaths: Set<string>, seenCaseInsensitivePaths: Map<string, string>, errors: string[]): string | undefined {
  try {
    const normalizedPath = normalizeBundlePath(path);
    if (normalizedPath !== path) errors.push(`Bundle file ${path} path is not normalized.`);
    if (seenPaths.has(normalizedPath)) errors.push(`Duplicate bundle file path: ${normalizedPath}.`);
    const caseInsensitivePath = normalizedPath.toLocaleLowerCase("en-US");
    const existingCaseInsensitivePath = seenCaseInsensitivePaths.get(caseInsensitivePath);
    if (existingCaseInsensitivePath && existingCaseInsensitivePath !== normalizedPath) {
      errors.push(`Bundle file path ${normalizedPath} collides case-insensitively with ${existingCaseInsensitivePath}.`);
    }
    seenPaths.add(normalizedPath);
    seenCaseInsensitivePaths.set(caseInsensitivePath, normalizedPath);
    return normalizedPath;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function normalizeBundlePath(path: string): string {
  if (path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:/.test(path)) {
    throw new Error("Skill bundle file path must be a safe forward-slash relative path.");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    validateSafeSegment(segment, "Skill bundle file path segment");
    if (isSensitiveEntryName(segment)) {
      throw new Error(`Sensitive file path is not shareable: ${path}.`);
    }
  }
  return segments.join("/");
}

function assertSafeHandle(handle: unknown): asserts handle is string {
  if (typeof handle !== "string" || handle.trim().length === 0) throw new Error("Skill handle must be a non-empty directory name.");
  if (handle !== handle.trim() || handle.includes("/") || handle.includes("\\") || handle.includes("\0") || /^[A-Za-z]:/.test(handle)) {
    throw new Error("Skill handle must be a single safe directory name.");
  }
  validateSafeSegment(handle, "Skill handle");
  if (handle.length > 128) throw new Error("Skill handle is too long.");
}

function validateSafeSegment(segment: string, label: string): void {
  if (segment.length === 0 || segment === "." || segment === "..") throw new Error(`${label} cannot contain traversal or empty segments.`);
  if (segment.includes(":")) throw new Error(`${label} cannot contain ':' or NTFS alternate data stream syntax.`);
  if (WINDOWS_FORBIDDEN_FILENAME_CHARACTER_PATTERN.test(segment)) throw new Error(`${label} cannot contain Windows-forbidden filename characters.`);
  if (/\p{C}/u.test(segment)) throw new Error(`${label} cannot contain control characters.`);
  if (segment.endsWith(".") || segment.endsWith(" ")) throw new Error(`${label} cannot end with a dot or space.`);
  const deviceName = segment.split(".", 1)[0] ?? segment;
  if (WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(deviceName)) throw new Error(`${label} cannot use a Windows reserved device name.`);
}

function isSensitiveEntryName(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith(".env") || lowerName.endsWith(".env")) return true;
  if (SENSITIVE_ENTRY_NAMES.has(lowerName)) return true;
  const extensionIndex = lowerName.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? lowerName.slice(extensionIndex) : "";
  return SENSITIVE_FILE_EXTENSIONS.has(extension);
}

function decodeFileContent(encoding: unknown, content: string): Uint8Array | undefined {
  if (encoding === "utf8") {
    if (content.includes("\0")) return undefined;
    return TEXT_ENCODER.encode(content);
  }
  if (encoding !== "base64" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) return undefined;
  try {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

function decodeTextContent(bytes: Uint8Array): { textContent?: string } {
  if (bytes.includes(0)) return {};
  try {
    return { textContent: TEXT_DECODER.decode(bytes) };
  } catch {
    return {};
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectUnknownKeys(record: Record<string, unknown>, allowedKeys: readonly string[], errors: string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${label} contains unsupported field: ${key}.`);
  }
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodePoint);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

function parseYamlKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) return undefined;
  const key = line.slice(0, separatorIndex).trim();
  if (!key) return undefined;
  return { key, value: line.slice(separatorIndex + 1).trim() };
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlBooleanValue(value: string): boolean | undefined {
  const normalized = parseYamlStringValue(value).toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return undefined;
}

function extractTopLevelFrontmatterKeys(frontmatter: string): string[] {
  const keys = new Set<string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line)) continue;
    const parsed = parseYamlKeyValue(line.trim());
    if (parsed) keys.add(parsed.key);
  }
  return Array.from(keys).sort(compareCodePoint);
}

function countLeadingSpaces(value: string): number {
  const match = /^\s*/.exec(value);
  return match ? match[0].length : 0;
}

function countObjectKeys(value: unknown): number {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSkillSourceKind(value: unknown): value is SkillSourceKind {
  return value === "builtin" || value === "repo" || value === "machine-local" || value === "profile";
}

function isValidScriptKind(value: unknown): value is SkillBundleScriptKind {
  return value === "shell" || value === "powershell" || value === "batch" || value === "node" || value === "python" || value === "ruby" || value === "go" || value === "rust" || value === "other";
}

function isValidDependencyManager(value: unknown): value is SkillBundleDependencyManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "pip" || value === "uv" || value === "poetry" || value === "cargo" || value === "go" || value === "other";
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareOsIndicators(left: SkillBundleOsIndicator, right: SkillBundleOsIndicator): number {
  return compareCodePoint(`${left.path}\0${left.token}`, `${right.path}\0${right.token}`);
}

function dedupeOsIndicators(indicators: SkillBundleOsIndicator[]): SkillBundleOsIndicator[] {
  const seen = new Set<string>();
  const deduped: SkillBundleOsIndicator[] = [];
  for (const indicator of indicators) {
    const key = `${indicator.path}\0${indicator.token}\0${indicator.severity}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(indicator);
    }
  }
  return deduped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

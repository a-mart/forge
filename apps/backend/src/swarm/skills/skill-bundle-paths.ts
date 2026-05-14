import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const WINDOWS_RESERVED_DEVICE_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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

export function normalizeSkillBundleFilePath(pathValue: string): string {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error("Skill bundle file path must be a non-empty string.");
  }

  if (pathValue.includes("\\") || pathValue.includes("\0")) {
    throw new Error("Skill bundle file path must use forward-slash relative paths.");
  }

  if (isAbsolute(pathValue) || win32.isAbsolute(pathValue) || pathValue.startsWith("/") || pathValue.startsWith("//")) {
    throw new Error("Skill bundle file path must be relative.");
  }

  const segments = pathValue.split("/");
  for (const segment of segments) {
    validateSafePathSegment(segment, "Skill bundle file path segment");
  }

  return segments.join("/");
}

export function assertValidSkillHandle(handle: unknown): asserts handle is string {
  if (typeof handle !== "string" || handle.trim().length === 0) {
    throw new Error("Skill handle must be a non-empty directory name.");
  }

  if (handle !== handle.trim() || handle.includes("/") || handle.includes("\\") || handle.includes("\0")) {
    throw new Error("Skill handle must be a single safe directory name.");
  }

  if (isAbsolute(handle) || win32.isAbsolute(handle) || /^[A-Za-z]:/.test(handle)) {
    throw new Error("Skill handle must not be absolute or traversal-like.");
  }

  validateSafePathSegment(handle, "Skill handle");

  if (handle.length > 128) {
    throw new Error("Skill handle is too long.");
  }
}

export function isSensitiveSkillEntryName(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith(".env") || lowerName.endsWith(".env")) {
    return true;
  }

  if (SENSITIVE_ENTRY_NAMES.has(lowerName)) {
    return true;
  }

  return SENSITIVE_FILE_EXTENSIONS.has(extname(lowerName));
}

function validateSafePathSegment(segment: string, label: string): void {
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw new Error(`${label} cannot contain traversal or empty segments.`);
  }

  if (segment.includes(":")) {
    throw new Error(`${label} cannot contain ':' or NTFS alternate data stream syntax.`);
  }

  if (/\p{C}/u.test(segment)) {
    throw new Error(`${label} cannot contain control characters.`);
  }

  if (segment.endsWith(".") || segment.endsWith(" ")) {
    throw new Error(`${label} cannot end with a dot or space.`);
  }

  const deviceName = segment.split(".", 1)[0] ?? segment;
  if (WINDOWS_RESERVED_DEVICE_NAME_PATTERN.test(deviceName)) {
    throw new Error(`${label} cannot use a Windows reserved device name.`);
  }
}

export function toBundleRelativePath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).replace(/\\/g, "/");
}

export function isPathWithinRoot(pathValue: string, rootPath: string): boolean {
  const normalizedPath = resolve(pathValue);
  const normalizedRoot = resolve(rootPath);
  if (normalizedPath === normalizedRoot) {
    return true;
  }

  return normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

export function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

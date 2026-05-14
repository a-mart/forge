import { extname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "auth.json",
  "credential-pool.json",
  "secrets.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
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
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Skill bundle file path cannot contain traversal or empty segments.");
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

  if (handle === "." || handle === ".." || isAbsolute(handle) || win32.isAbsolute(handle) || /^[A-Za-z]:/.test(handle)) {
    throw new Error("Skill handle must not be absolute or traversal-like.");
  }

  if (handle.length > 128) {
    throw new Error("Skill handle is too long.");
  }
}

export function isSensitiveSkillFileName(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (SENSITIVE_FILE_NAMES.has(lowerName)) {
    return true;
  }

  return SENSITIVE_FILE_EXTENSIONS.has(extname(lowerName));
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

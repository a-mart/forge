export function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export function isErrnoCodeIn(error: unknown, codes: string[]): boolean {
  return codes.some((code) => isErrnoCode(error, code));
}

export function isEnoentError(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

export function isNotDirLikeMissingError(error: unknown): boolean {
  return isErrnoCodeIn(error, ["ENOENT", "ENOTDIR"]);
}

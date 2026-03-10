export const IS_WINDOWS = process.platform === "win32";

export function isWindows(): boolean {
  return IS_WINDOWS;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    );
  }
}

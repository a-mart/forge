/**
 * Forge Node engine floor for the Pi 0.80.6 upgrade.
 * Keep this predicate shared by backend startup and Electron/preflight tests.
 */
export const FORGE_MIN_NODE_VERSION = "22.19.0";

export type NodeVersionParts = {
  major: number;
  minor: number;
  patch: number;
};

export function parseNodeVersion(version: string): NodeVersionParts | null {
  const normalized = version.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(normalized);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareNodeVersions(left: NodeVersionParts, right: NodeVersionParts): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function satisfiesNodeEngineFloor(
  version: string,
  minimum: string = FORGE_MIN_NODE_VERSION,
): boolean {
  const actual = parseNodeVersion(version);
  const floor = parseNodeVersion(minimum);
  if (!actual || !floor) {
    return false;
  }
  return compareNodeVersions(actual, floor) >= 0;
}

export function assertNodeEngineFloor(
  version: string = process.version,
  minimum: string = FORGE_MIN_NODE_VERSION,
): void {
  if (satisfiesNodeEngineFloor(version, minimum)) {
    return;
  }
  throw new Error(
    `Forge requires Node.js >=${minimum} (current: ${version}). ` +
      `Raise the runtime before starting the backend or packaging Electron.`,
  );
}

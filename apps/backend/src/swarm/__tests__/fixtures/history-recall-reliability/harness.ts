import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MARKER_FILENAME, MARKER_KIND, ROOT_DIR_PREFIX } from "./ids.js";

export interface DisposableRoot {
  dataDir: string;
  markerPath: string;
  createdAt: string;
}

export interface RootMarker {
  kind: typeof MARKER_KIND;
  createdAt: string;
  pid: number;
  purpose: string;
}

export async function createMarkedDataRoot(purpose: string): Promise<DisposableRoot> {
  const dataDir = await mkdtemp(join(tmpdir(), ROOT_DIR_PREFIX));
  const createdAt = new Date().toISOString();
  const markerPath = join(dataDir, MARKER_FILENAME);
  const marker: RootMarker = {
    kind: MARKER_KIND,
    createdAt,
    pid: process.pid,
    purpose,
  };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return { dataDir, markerPath, createdAt };
}

export async function readMarker(dataDir: string): Promise<RootMarker | undefined> {
  try {
    const raw = await readFile(join(dataDir, MARKER_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as RootMarker;
    if (parsed?.kind !== MARKER_KIND) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function isHarnessOwnedRoot(dataDir: string): Promise<boolean> {
  const resolved = resolve(dataDir);
  const tmp = resolve(tmpdir());
  if (resolved === tmp || !resolved.startsWith(`${tmp}/`) && !resolved.startsWith(`${tmp}\\`)) {
    return false;
  }
  if (!resolved.includes(ROOT_DIR_PREFIX)) {
    return false;
  }
  return Boolean(await readMarker(resolved));
}

export async function removeMarkedDataRoot(dataDir: string): Promise<{ removed: boolean; reason: string }> {
  const resolved = resolve(dataDir);
  if (process.env.FORGE_DATA_DIR && resolve(process.env.FORGE_DATA_DIR) === resolved) {
    return { removed: false, reason: "refused: path equals FORGE_DATA_DIR" };
  }
  if (process.env.MIDDLEMAN_DATA_DIR && resolve(process.env.MIDDLEMAN_DATA_DIR) === resolved) {
    return { removed: false, reason: "refused: path equals MIDDLEMAN_DATA_DIR" };
  }
  if (!(await isHarnessOwnedRoot(resolved))) {
    return { removed: false, reason: "refused: missing harness marker or not a tmp root" };
  }
  await rm(resolved, { recursive: true, force: true });
  return { removed: true, reason: "removed harness-created marked root" };
}

export function assertNotDefaultDataDir(dataDir: string): void {
  const resolved = resolve(dataDir);
  for (const name of ["FORGE_DATA_DIR", "MIDDLEMAN_DATA_DIR"] as const) {
    const value = process.env[name];
    if (value && resolve(value) === resolved) {
      throw new Error(`Refusing to use ${name} as a synthetic history-recall data root`);
    }
  }
}

export async function writeUtf8(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

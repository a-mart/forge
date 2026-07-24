import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const COPY_SCHEMA_VERSION = 1;
export const DEFAULT_SOURCE = "/Users/adam/.forge";
export const DEFAULT_TARGET = "/Users/adam/.forge-e2e-secure-sessions-20260723";
export const DEFAULT_ELECTRON_USER_DATA =
  "/Users/adam/Library/Application Support/@forge/electron-secure-sessions";
export const DEFAULT_BACKEND_PORT = 47687;
export const DEFAULT_UI_PORT = 47688;
export const MANIFEST_NAME = ".secure-sessions-copy.json";
export const QUARANTINE_DIR_NAME = ".secure-sessions-quarantine";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..");
const backendRequire = createRequire(join(repoRoot, "apps", "backend", "package.json"));
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const PRODUCTION_DATA_CANDIDATES = [
  resolve(homedir(), ".forge"),
  resolve(homedir(), "Library", "Application Support", "forge"),
];
const PRODUCTION_ELECTRON_USER_DATA_CANDIDATES = [
  resolve(homedir(), "Library", "Application Support", "@forge", "electron"),
  resolve(homedir(), "Library", "Application Support", "Forge"),
];
const FORBIDDEN_PORTS = new Set([47187, 47188, 47189, 47287, 47387, 47388]);
const SENSITIVE_ACTIVE_PATHS = [
  "shared/config/auth",
  "shared/config/secrets.json",
];

const DANGEROUS_CONFIG_NAME_PATTERN =
  /(?:schedule|goal|mobile|notification|phoenix|observab|remote[-_.]?build|remote[-_.]?project|collab|tunnel|cloudflar|webhook|extension|terminal|project[-_.]?resource|telemetry|cortex[-_.]?auto)/i;
const DANGEROUS_KEY_PATTERN =
  /(?:schedule|auto.?resume|auto.?run|mobile.?push|push.?notification|phoenix|observab|remote.?build|remote.?project|collab|tunnel|cloudflar|webhook|terminal.?restore|telemetry)/i;

export class IsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IsolationError";
  }
}

export function getRepoRoot() {
  return repoRoot;
}

export function loadDatabaseConstructor() {
  return backendRequire("better-sqlite3");
}

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function realpathOrResolved(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

export async function assertSeparatedPaths(sourcePath, targetPath) {
  if (!isAbsolute(sourcePath) || !isAbsolute(targetPath)) {
    throw new IsolationError("Source and target must both be absolute paths.");
  }
  const source = await realpathOrResolved(sourcePath);
  const target = await realpathOrResolved(targetPath);
  if (isSameOrInside(target, source) || isSameOrInside(source, target)) {
    throw new IsolationError("Source and target overlap; refusing to continue.");
  }
  return { source, target };
}

export async function assertIsolatedDataPath(dataPath, sourcePath = DEFAULT_SOURCE) {
  if (!isAbsolute(dataPath)) {
    throw new IsolationError("FORGE_DATA_DIR must be an absolute path.");
  }
  const dataRealpath = await realpathOrResolved(dataPath);
  const sourceRealpath = await realpathOrResolved(sourcePath);
  if (isSameOrInside(dataRealpath, sourceRealpath) || isSameOrInside(sourceRealpath, dataRealpath)) {
    throw new IsolationError("Isolated data path overlaps the source data path.");
  }
  for (const candidate of PRODUCTION_DATA_CANDIDATES) {
    const candidateRealpath = await realpathOrResolved(candidate);
    if (isSameOrInside(dataRealpath, candidateRealpath)) {
      throw new IsolationError("Isolated data path resolves to a production Forge data location.");
    }
  }
  const info = await lstat(dataRealpath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new IsolationError("Isolated data path must be a real directory, not a symlink.");
  }
  return dataRealpath;
}

export async function assertIsolatedElectronUserData(userDataPath) {
  if (!isAbsolute(userDataPath)) {
    throw new IsolationError("Electron user-data path must be absolute.");
  }
  const candidate = await realpathOrResolved(userDataPath);
  for (const productionPath of PRODUCTION_ELECTRON_USER_DATA_CANDIDATES) {
    const production = await realpathOrResolved(productionPath);
    if (isSameOrInside(candidate, production) || isSameOrInside(production, candidate)) {
      throw new IsolationError("Electron user-data path overlaps a production Electron state location.");
    }
  }
  return candidate;
}

export function assertIsolatedPort(port, label) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1024 || numeric > 65535) {
    throw new IsolationError(`${label} must be an integer between 1024 and 65535.`);
  }
  if (FORBIDDEN_PORTS.has(numeric)) {
    throw new IsolationError(`${label} uses a reserved Forge port.`);
  }
  return numeric;
}

async function collectEntries(root) {
  const entries = [];
  const visit = async (current, relativePath) => {
    const directoryEntries = await readdir(current, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = join(current, entry.name);
      const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        const referentInfo = await stat(absolutePath);
        if (!referentInfo.isFile()) {
          throw new IsolationError("Source data contains a non-file symlink; refusing an aliasing copy.");
        }
        entries.push({
          absolutePath,
          relativePath: childRelative,
          info: referentInfo,
          kind: "file",
          materializedSymlink: true,
          linkTarget: await readlink(absolutePath),
        });
        continue;
      }
      if (info.isDirectory()) {
        entries.push({ absolutePath, relativePath: childRelative, info, kind: "directory" });
        await visit(absolutePath, childRelative);
      } else if (info.isFile()) {
        entries.push({ absolutePath, relativePath: childRelative, info, kind: "file" });
      } else {
        throw new IsolationError("Source data contains a non-file, non-directory entry.");
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function hasSqliteHeader(path, size) {
  if (size < SQLITE_HEADER.length) return false;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === SQLITE_HEADER.length && buffer.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

async function classifyEntries(root) {
  const entries = await collectEntries(root);
  const sqliteEntries = [];
  for (const entry of entries) {
    if (entry.kind === "file" && (await hasSqliteHeader(entry.absolutePath, entry.info.size))) {
      sqliteEntries.push(entry);
    }
  }
  const sqliteSkip = new Set();
  for (const entry of sqliteEntries) {
    sqliteSkip.add(normalize(entry.relativePath));
    sqliteSkip.add(normalize(`${entry.relativePath}-wal`));
    sqliteSkip.add(normalize(`${entry.relativePath}-shm`));
    sqliteSkip.add(normalize(`${entry.relativePath}-journal`));
  }
  return { entries, sqliteEntries, sqliteSkip };
}

function rawMetadataMap(classification) {
  const metadata = new Map();
  for (const entry of classification.entries) {
    if (entry.kind !== "file" || classification.sqliteSkip.has(normalize(entry.relativePath))) continue;
    metadata.set(normalize(entry.relativePath), {
      size: entry.info.size,
      mtimeMs: Math.trunc(entry.info.mtimeMs),
      mode: entry.info.mode & 0o777,
      linkTarget: entry.linkTarget ?? null,
    });
  }
  return metadata;
}

function assertMetadataStable(before, after) {
  if (before.size !== after.size) {
    throw new IsolationError("Source data changed during copy; stop Forge and retry.");
  }
  for (const [path, expected] of before.entries()) {
    const actual = after.get(path);
    if (
      !actual ||
      actual.size !== expected.size ||
      actual.mtimeMs !== expected.mtimeMs ||
      actual.mode !== expected.mode ||
      actual.linkTarget !== expected.linkTarget
    ) {
      throw new IsolationError("Source data changed during copy; stop Forge and retry.");
    }
  }
}

function escapeRsyncPattern(path) {
  return path.split(sep).join("/").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function runRsync(source, destination, sqliteSkip, excludeFilePath) {
  const excludes = [...sqliteSkip].sort().map((path) => `/${escapeRsyncPattern(path)}`);
  await writeFile(excludeFilePath, `${excludes.join("\n")}\n`, { mode: 0o600 });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "/usr/bin/rsync",
      [
        "-a",
        "--copy-links",
        `--exclude-from=${excludeFilePath}`,
        `${source}${sep}`,
        `${destination}${sep}`,
      ],
      { stdio: "ignore" },
    );
    child.once("error", () => rejectPromise(new IsolationError("Unable to start the metadata-preserving copy.")));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new IsolationError(
            `Metadata-preserving copy failed with code ${String(code)} signal ${String(signal)}.`,
          ),
        );
      }
    });
  });
}

async function backupSqliteDatabases(sqliteEntries, sourceRoot, destinationRoot) {
  const Database = loadDatabaseConstructor();
  for (const entry of sqliteEntries) {
    const sourcePath = join(sourceRoot, entry.relativePath);
    const destinationPath = join(destinationRoot, entry.relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    const database = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await database.backup(destinationPath);
    } finally {
      database.close();
    }
    await chmod(destinationPath, entry.info.mode & 0o777);
    await utimes(destinationPath, entry.info.atime, entry.info.mtime);
    await assertSqliteQuickCheck(destinationPath);
  }
}

export async function assertSqliteQuickCheck(databasePath) {
  const Database = loadDatabaseConstructor();
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.pragma("quick_check");
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      rows.some((row) => !row || typeof row !== "object" || row.quick_check !== "ok")
    ) {
      throw new IsolationError("A copied SQLite database failed PRAGMA quick_check.");
    }
  } finally {
    database.close();
  }
}

function shouldQuarantine(relativePath, kind) {
  const normalizedPath = relativePath.split(sep).join("/");
  const segments = normalizedPath.split("/");
  if (
    normalizedPath === "runtime.lock" ||
    normalizedPath === "shared/state/mobile-devices.json" ||
    normalizedPath === "shared/config/mobile-notification-prefs.json" ||
    normalizedPath === "shared/config/notification-settings.json" ||
    normalizedPath === "shared/config/phoenix-observability.json" ||
    normalizedPath === "shared/config/project-resources.json" ||
    normalizedPath === "shared/config/remote-build-settings.json" ||
    normalizedPath === "shared/config/telemetry.json" ||
    normalizedPath === "shared/config/cortex-auto-review.json" ||
    normalizedPath === "agent/settings.json" ||
    normalizedPath === "agent/manager/settings.json"
  ) {
    return true;
  }
  if (
    normalizedPath === "shared/config/collaboration" ||
    normalizedPath === "shared/config/integrations" ||
    normalizedPath === "shared/integrations" ||
    normalizedPath === "integrations" ||
    normalizedPath === "extensions" ||
    normalizedPath === "agent/extensions" ||
    normalizedPath === "agent/manager/extensions"
  ) {
    return kind === "directory";
  }
  if (segments[0] === "profiles" && segments.length >= 3) {
    if (segments[2] === "extensions" && kind === "directory") return true;
    if (segments[2] === "pi" && segments[3] === "extensions" && kind === "directory") return true;
    if (segments[2] === "pi" && segments[3] === "settings.json") return true;
    if (segments[2] === "schedules" && segments[3] === "schedules.json") return true;
    if (
      segments[2] === "sessions" &&
      segments.length >= 5 &&
      (segments[4] === "goal.json" || (segments[4] === "terminals" && kind === "directory"))
    ) {
      return true;
    }
  }
  if (
    (segments[0] === "shared" && (segments[1] === "config" || segments[1] === "state")) &&
    DANGEROUS_CONFIG_NAME_PATTERN.test(basename(normalizedPath))
  ) {
    return true;
  }
  return false;
}

async function quarantineDangerousState(
  destinationRoot,
  quarantineNamespace = "files",
) {
  const entries = await collectEntries(destinationRoot);
  const candidates = entries
    .filter((entry) => shouldQuarantine(entry.relativePath, entry.kind))
    .sort((left, right) => {
      const depthDelta = left.relativePath.split(sep).length - right.relativePath.split(sep).length;
      return depthDelta || left.relativePath.localeCompare(right.relativePath);
    });
  const quarantineRoot = join(
    destinationRoot,
    QUARANTINE_DIR_NAME,
    quarantineNamespace,
  );
  const moved = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.absolutePath))) continue;
    const quarantinePath = join(quarantineRoot, candidate.relativePath);
    await mkdir(dirname(quarantinePath), { recursive: true, mode: 0o700 });
    await rename(candidate.absolutePath, quarantinePath);
    moved.push(candidate.relativePath.split(sep).join("/"));
  }
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  return moved;
}

async function hardenSensitivePermissions(destinationRoot) {
  await chmod(destinationRoot, 0o700);
  for (const relativePath of SENSITIVE_ACTIVE_PATHS) {
    const absolutePath = join(destinationRoot, relativePath);
    if (!(await pathExists(absolutePath))) continue;
    const entries = [absolutePath];
    const rootInfo = await lstat(absolutePath);
    if (rootInfo.isDirectory()) {
      for (const child of await collectEntries(absolutePath)) entries.push(child.absolutePath);
    }
    for (const path of entries) {
      const info = await lstat(path);
      await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    }
  }
  const quarantineRoot = join(destinationRoot, QUARANTINE_DIR_NAME);
  if (await pathExists(quarantineRoot)) {
    const paths = [quarantineRoot, ...(await collectEntries(quarantineRoot)).map((entry) => entry.absolutePath)];
    for (const path of paths) {
      const info = await lstat(path);
      await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    }
  }
}

function manifestPath(dataRoot) {
  return join(dataRoot, MANIFEST_NAME);
}

export async function readManifest(dataRoot) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath(dataRoot), "utf8"));
  } catch {
    throw new IsolationError("Isolated data manifest is missing or invalid.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== COPY_SCHEMA_VERSION ||
    parsed.prepared !== true
  ) {
    throw new IsolationError("Isolated data manifest does not prove a completed preparation.");
  }
  return parsed;
}

async function assertNoHardlinkedSensitiveFiles(sourceRoot, destinationRoot) {
  for (const relativePath of [
    "shared/config/auth/auth.json",
    "shared/config/auth/credential-pool.json",
    "shared/config/secrets.json",
  ]) {
    const sourcePath = join(sourceRoot, relativePath);
    const destinationPath = join(destinationRoot, relativePath);
    if (!(await pathExists(sourcePath)) || !(await pathExists(destinationPath))) continue;
    const sourceInfo = await stat(sourcePath);
    const destinationInfo = await stat(destinationPath);
    if (sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino) {
      throw new IsolationError("A sensitive destination file is hardlinked to the source.");
    }
  }
}

export async function prepareIsolatedData({
  sourcePath = DEFAULT_SOURCE,
  targetPath = DEFAULT_TARGET,
  electronUserDataPath = DEFAULT_ELECTRON_USER_DATA,
  now = () => new Date(),
} = {}) {
  const separated = await assertSeparatedPaths(sourcePath, targetPath);
  const sourceInfo = await lstat(separated.source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new IsolationError("Source must be a real directory.");
  }
  await assertIsolatedElectronUserData(electronUserDataPath);

  if (await pathExists(separated.target)) {
    const existingManifest = await readManifest(separated.target);
    if (
      (await realpathOrResolved(existingManifest.sourcePath)) !== separated.source ||
      (await realpathOrResolved(existingManifest.targetPath)) !== separated.target
    ) {
      throw new IsolationError("Existing target manifest does not match the requested source and target.");
    }
    await assertPreparedIsolation({
      dataPath: separated.target,
      sourcePath: separated.source,
      electronUserDataPath,
      requireLaunchEnv: false,
    });
    return { status: "already-prepared", manifest: existingManifest };
  }

  if (await pathExists(join(separated.source, "runtime.lock"))) {
    throw new IsolationError("Source runtime.lock exists; stop Forge cleanly before copying.");
  }

  const stagingPath = join(
    dirname(separated.target),
    `.${basename(separated.target)}.staging-${process.pid}-${randomUUID()}`,
  );
  const excludeFilePath = `${stagingPath}.rsync-excludes`;
  if (await pathExists(stagingPath)) {
    throw new IsolationError("Generated staging path unexpectedly exists.");
  }

  try {
    const before = await classifyEntries(separated.source);
    const beforeRawMetadata = rawMetadataMap(before);
    await runRsync(separated.source, stagingPath, before.sqliteSkip, excludeFilePath);
    await backupSqliteDatabases(before.sqliteEntries, separated.source, stagingPath);

    const after = await classifyEntries(separated.source);
    assertMetadataStable(beforeRawMetadata, rawMetadataMap(after));
    if (await pathExists(join(separated.source, "runtime.lock"))) {
      throw new IsolationError("Forge started while the copy was running; refusing the snapshot.");
    }

    const quarantinedPaths = await quarantineDangerousState(stagingPath);
    await hardenSensitivePermissions(stagingPath);
    await assertNoHardlinkedSensitiveFiles(separated.source, stagingPath);

    const manifest = {
      schemaVersion: COPY_SCHEMA_VERSION,
      prepared: true,
      sourcePath: separated.source,
      targetPath: separated.target,
      electronUserDataPath: await realpathOrResolved(electronUserDataPath),
      backendPort: DEFAULT_BACKEND_PORT,
      uiPort: DEFAULT_UI_PORT,
      createdAt: now().toISOString(),
      sourceEntryCount: before.entries.length,
      sqliteBackupCount: before.sqliteEntries.length,
      quarantinedPathCount: quarantinedPaths.length,
      quarantinedPaths,
    };
    await writeFile(manifestPath(stagingPath), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(stagingPath, separated.target);
    await assertPreparedIsolation({
      dataPath: separated.target,
      sourcePath: separated.source,
      electronUserDataPath,
      requireLaunchEnv: false,
    });
    return { status: "prepared", manifest };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(excludeFilePath, { force: true });
  }
}

export async function resetPreparedIsolation({
  dataPath = DEFAULT_TARGET,
  sourcePath = DEFAULT_SOURCE,
  electronUserDataPath = DEFAULT_ELECTRON_USER_DATA,
  now = () => new Date(),
} = {}) {
  const dataRoot = await assertIsolatedDataPath(dataPath, sourcePath);
  await assertIsolatedElectronUserData(electronUserDataPath);
  const rootInfo = await lstat(dataRoot);
  if ((rootInfo.mode & 0o077) !== 0) {
    throw new IsolationError("Isolated data root must not be group/world accessible.");
  }
  const manifest = await readManifest(dataRoot);
  if (
    (await realpathOrResolved(manifest.sourcePath))
      !== (await realpathOrResolved(sourcePath))
    || (await realpathOrResolved(manifest.targetPath)) !== dataRoot
  ) {
    throw new IsolationError("Manifest source or target identity does not match.");
  }

  const runId = `${now().toISOString().replace(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}`;
  const quarantinedPaths = await quarantineDangerousState(
    dataRoot,
    join("reruns", runId),
  );
  await hardenSensitivePermissions(dataRoot);
  await assertSensitivePermissions(dataRoot);
  await assertNoDangerousActiveState(dataRoot);
  return {
    status: "reset",
    quarantinedPathCount: quarantinedPaths.length,
    quarantinedPaths,
  };
}

function isTruthyDangerousValue(value) {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();
    return normalizedValue !== "" && !["false", "off", "disabled", "none", "0"].includes(normalizedValue);
  }
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function findDangerousJsonKey(value, keyPath = []) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = findDangerousJsonKey(value[index], [...keyPath, String(index)]);
      if (match) return match;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...keyPath, key];
    if (DANGEROUS_KEY_PATTERN.test(key) && isTruthyDangerousValue(child)) {
      return nextPath.join(".");
    }
    const nested = findDangerousJsonKey(child, nextPath);
    if (nested) return nested;
  }
  return null;
}

async function assertNoDangerousActiveState(dataRoot) {
  const entries = await collectEntries(dataRoot);
  for (const entry of entries) {
    if (entry.relativePath === QUARANTINE_DIR_NAME || entry.relativePath.startsWith(`${QUARANTINE_DIR_NAME}${sep}`)) {
      continue;
    }
    if (shouldQuarantine(entry.relativePath, entry.kind)) {
      throw new IsolationError("Dangerous automation state remains active outside quarantine.");
    }
    const normalizedPath = entry.relativePath.split(sep).join("/");
    if (
      entry.kind === "file" &&
      normalizedPath.endsWith(".json") &&
      (normalizedPath.startsWith("shared/config/") || normalizedPath.startsWith("shared/state/")) &&
      !normalizedPath.startsWith("shared/config/auth/") &&
      normalizedPath !== "shared/config/secrets.json"
    ) {
      let parsed;
      try {
        parsed = JSON.parse(await readFile(entry.absolutePath, "utf8"));
      } catch {
        throw new IsolationError("An active config/state JSON file is invalid.");
      }
      const dangerousKey = findDangerousJsonKey(parsed);
      if (dangerousKey) {
        throw new IsolationError(
          `Dangerous enabled automation remains in active config/state at key ${dangerousKey}.`,
        );
      }
    }
  }
}

async function assertSensitivePermissions(dataRoot) {
  for (const relativePath of [
    "shared/config/auth/auth.json",
    "shared/config/auth/credential-pool.json",
    "shared/config/secrets.json",
  ]) {
    const absolutePath = join(dataRoot, relativePath);
    if (!(await pathExists(absolutePath))) continue;
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new IsolationError("An active credential file is not a private regular file.");
    }
  }
  const requiredAuth = join(dataRoot, "shared/config/auth/auth.json");
  if (!(await pathExists(requiredAuth))) {
    throw new IsolationError("Provider auth is missing from the isolated data copy.");
  }
}

export function assertLaunchEnvironment(
  env,
  {
    dataPath,
    electronUserDataPath,
    backendPort = DEFAULT_BACKEND_PORT,
    uiPort = DEFAULT_UI_PORT,
  },
) {
  const expected = {
    FORGE_RUNTIME_TARGET: "builder",
    FORGE_HOST: "127.0.0.1",
    FORGE_PORT: String(backendPort),
    FORGE_UI_PORT: String(uiPort),
    FORGE_DATA_DIR: dataPath,
    FORGE_ELECTRON_DEV_SERVER_URL: `http://127.0.0.1:${uiPort}`,
    FORGE_ELECTRON_USER_DATA_DIR: electronUserDataPath,
    VITE_FORGE_WS_URL: `ws://127.0.0.1:${backendPort}`,
    FORGE_TELEMETRY: "false",
    FORGE_CORTEX_ENABLED: "false",
    FORGE_TERMINAL_ENABLED: "false",
    FORGE_SKILL_SHARE_DISABLED: "true",
    FORGE_REMOTE_PROJECTS_ENABLED: "false",
    FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED: "false",
    FORGE_VERSIONING_ENABLED: "false",
    FORGE_DEBUG: "false",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) {
      throw new IsolationError(`Launch environment is missing the required isolated value for ${key}.`);
    }
  }
  for (const key of [
    "FORGE_ADMIN_EMAIL",
    "FORGE_ADMIN_PASSWORD",
    "FORGE_COLLABORATION_AUTH_SECRET",
    "FORGE_COLLABORATION_BASE_URL",
  ]) {
    if (typeof env[key] === "string" && env[key].trim()) {
      throw new IsolationError(`Launch environment must not set ${key}.`);
    }
  }
  assertIsolatedPort(backendPort, "FORGE_PORT");
  assertIsolatedPort(uiPort, "FORGE_UI_PORT");
}

export async function assertPreparedIsolation({
  dataPath = DEFAULT_TARGET,
  sourcePath = DEFAULT_SOURCE,
  electronUserDataPath = DEFAULT_ELECTRON_USER_DATA,
  backendPort = DEFAULT_BACKEND_PORT,
  uiPort = DEFAULT_UI_PORT,
  env = process.env,
  requireLaunchEnv = true,
} = {}) {
  const dataRoot = await assertIsolatedDataPath(dataPath, sourcePath);
  const electronRoot = await assertIsolatedElectronUserData(electronUserDataPath);
  assertIsolatedPort(backendPort, "FORGE_PORT");
  assertIsolatedPort(uiPort, "FORGE_UI_PORT");
  const rootInfo = await lstat(dataRoot);
  if ((rootInfo.mode & 0o077) !== 0) {
    throw new IsolationError("Isolated data root must not be group/world accessible.");
  }
  const manifest = await readManifest(dataRoot);
  if (
    (await realpathOrResolved(manifest.sourcePath)) !== (await realpathOrResolved(sourcePath)) ||
    (await realpathOrResolved(manifest.targetPath)) !== dataRoot
  ) {
    throw new IsolationError("Manifest source or target identity does not match.");
  }
  await assertSensitivePermissions(dataRoot);
  await assertNoDangerousActiveState(dataRoot);
  if (requireLaunchEnv) {
    assertLaunchEnvironment(env, {
      dataPath,
      electronUserDataPath,
      backendPort,
      uiPort,
    });
  }
  return {
    ok: true,
    dataPath: dataRoot,
    electronUserDataPath: electronRoot,
    backendPort,
    uiPort,
    providerAuthPresent: true,
    dangerousAutomationActive: false,
  };
}

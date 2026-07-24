import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { SqliteDatabaseConstructor } from "../../types.js";
import { runSecureSessionMigrations } from "./secure-session-migrations.js";

export interface SecureSessionDatabaseOptions {
  dbPath: string;
  loadDatabaseModule: () => Promise<SqliteDatabaseConstructor>;
}

const instances = new Map<string, Database.Database>();
const openPromises = new Map<string, Promise<Database.Database>>();
const closePromises = new Map<string, Promise<void>>();

export async function getOrCreateSecureSessionDb(
  options: SecureSessionDatabaseOptions
): Promise<Database.Database> {
  const dbPath = requireDbPath(options.dbPath);
  if (closePromises.has(dbPath)) {
    throw new Error("Secure session database is closing");
  }

  const existing = instances.get(dbPath);
  if (existing?.open) {
    return existing;
  }
  const pending = openPromises.get(dbPath);
  if (pending) {
    return pending;
  }

  const openPromise = openDatabase(options, dbPath);
  openPromises.set(dbPath, openPromise);
  try {
    const database = await openPromise;
    instances.set(dbPath, database);
    return database;
  } finally {
    openPromises.delete(dbPath);
  }
}

export async function closeSecureSessionDb(dbPath: string): Promise<void> {
  const normalizedPath = requireDbPath(dbPath);
  const existingClose = closePromises.get(normalizedPath);
  if (existingClose) {
    return existingClose;
  }

  const closePromise = (async () => {
    let database = instances.get(normalizedPath);
    if (!database) {
      try {
        database = await openPromises.get(normalizedPath);
      } catch {
        database = undefined;
      }
    }
    instances.delete(normalizedPath);
    if (database?.open) {
      hardenDatabaseFiles(normalizedPath);
      database.close();
      hardenDatabaseFiles(normalizedPath);
    }
  })();
  closePromises.set(normalizedPath, closePromise);
  try {
    await closePromise;
  } finally {
    closePromises.delete(normalizedPath);
  }
}

function requireDbPath(dbPath: string): string {
  if (!dbPath.trim()) {
    throw new Error("Secure session database path is required");
  }
  return dbPath;
}

async function openDatabase(
  options: SecureSessionDatabaseOptions,
  dbPath: string
): Promise<Database.Database> {
  const DatabaseConstructor = await options.loadDatabaseModule();
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseConstructor(dbPath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    runSecureSessionMigrations(database);
    hardenDatabaseFiles(dbPath);
    return database;
  } catch (error) {
    if (database.open) {
      database.close();
    }
    hardenDatabaseFiles(dbPath);
    throw error;
  }
}

export function hardenDatabaseFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort: sidecars may not exist yet and ownership can vary on managed filesystems.
    }
  }
}

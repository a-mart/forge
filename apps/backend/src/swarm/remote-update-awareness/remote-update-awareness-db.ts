import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import type { SqliteDatabaseConstructor, SwarmConfig } from "../types.js";
import { runRemoteUpdateAwarenessMigrations } from "./remote-update-awareness-migrations.js";

const instances = new Map<string, Database.Database>();
const openPromises = new Map<string, Promise<Database.Database>>();
const closePromises = new Map<string, Promise<void>>();

export async function getOrCreateRemoteUpdateAwarenessDb(
  config: Pick<SwarmConfig, "paths" | "remoteUpdateAwarenessModules">
): Promise<Database.Database> {
  const dbPath = requireDbPath(config);
  if (closePromises.has(dbPath)) {
    throw new Error("Remote update awareness database is closing");
  }

  const existing = instances.get(dbPath);
  if (existing?.open) {
    return existing;
  }

  const pending = openPromises.get(dbPath);
  if (pending) {
    return pending;
  }

  const promise = openDatabase(config, dbPath);
  openPromises.set(dbPath, promise);
  try {
    const database = await promise;
    instances.set(dbPath, database);
    return database;
  } finally {
    openPromises.delete(dbPath);
  }
}

export async function closeRemoteUpdateAwarenessDb(
  config: Pick<SwarmConfig, "paths">
): Promise<void> {
  const dbPath = config.paths.remoteUpdateAwarenessDbPath;
  if (!dbPath) {
    return;
  }

  const existingClose = closePromises.get(dbPath);
  if (existingClose) {
    return existingClose;
  }

  const closePromise = (async () => {
    let database = instances.get(dbPath);
    if (!database) {
      try {
        database = await openPromises.get(dbPath);
      } catch {
        database = undefined;
      }
    }

    instances.delete(dbPath);
    if (database?.open) {
      database.close();
    }
  })();
  closePromises.set(dbPath, closePromise);

  try {
    await closePromise;
  } finally {
    closePromises.delete(dbPath);
  }
}

async function openDatabase(
  config: Pick<SwarmConfig, "paths" | "remoteUpdateAwarenessModules">,
  dbPath: string
): Promise<Database.Database> {
  const loader = config.remoteUpdateAwarenessModules?.loadDatabaseModule;
  if (!loader) {
    throw new Error("Missing remote update awareness database module loader");
  }

  const DatabaseConstructor: SqliteDatabaseConstructor = await loader();
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseConstructor(dbPath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    runRemoteUpdateAwarenessMigrations(database);
    return database;
  } catch (error) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}

function requireDbPath(config: Pick<SwarmConfig, "paths">): string {
  const dbPath = config.paths.remoteUpdateAwarenessDbPath;
  if (!dbPath) {
    throw new Error("Missing remote update awareness database path in config");
  }
  return dbPath;
}

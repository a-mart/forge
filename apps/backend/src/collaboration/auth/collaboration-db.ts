import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { CollaborationDatabaseConstructor, SwarmConfig } from "../../swarm/types.js";

const dbInstances = new Map<string, Database.Database>();
const dbOpenPromises = new Map<string, Promise<Database.Database>>();

export async function getOrCreateCollaborationAuthDb(config: SwarmConfig): Promise<Database.Database> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget)) {
    throw new Error("Collaboration auth DB requested while collaboration server runtime is disabled");
  }

  const dbPath = config.paths.collaborationAuthDbPath;
  if (!dbPath) {
    throw new Error("Missing collaboration auth DB path in config");
  }

  const existing = dbInstances.get(dbPath);
  if (existing) {
    return existing;
  }

  const pending = dbOpenPromises.get(dbPath);
  if (pending) {
    return pending;
  }

  const openPromise = openCollaborationAuthDb(config, dbPath);
  dbOpenPromises.set(dbPath, openPromise);

  try {
    const database = await openPromise;
    dbInstances.set(dbPath, database);
    return database;
  } finally {
    dbOpenPromises.delete(dbPath);
  }
}

export function closeCollaborationAuthDb(config: Pick<SwarmConfig, "paths">): void {
  const dbPath = config.paths.collaborationAuthDbPath;
  if (!dbPath) {
    return;
  }

  dbOpenPromises.delete(dbPath);

  const database = dbInstances.get(dbPath);
  if (!database) {
    return;
  }

  dbInstances.delete(dbPath);
  database.close();
}

async function openCollaborationAuthDb(
  config: SwarmConfig,
  dbPath: string,
): Promise<Database.Database> {
  const DatabaseConstructor = await loadDatabaseConstructor(config);
  mkdirSync(dirname(dbPath), { recursive: true });

  const database = new DatabaseConstructor(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  return database;
}

async function loadDatabaseConstructor(
  config: SwarmConfig,
): Promise<CollaborationDatabaseConstructor> {
  const loader = config.collaborationModules?.loadDatabaseModule;
  if (!loader) {
    throw new Error("Missing collaboration database module loader in config");
  }

  return loader();
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runRemoteUpdateAwarenessMigrations } from "../remote-update-awareness-migrations.js";
import { RemoteUpdateAwarenessStore } from "../remote-update-awareness-store.js";
import type { ResolvedRemoteUpdateTarget } from "../types.js";

export async function createTestStore(): Promise<{ database: Database.Database; store: RemoteUpdateAwarenessStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "forge-remote-awareness-"));
  const path = join(directory, "awareness.db");
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  runRemoteUpdateAwarenessMigrations(database);
  return { database, store: new RemoteUpdateAwarenessStore(database), path };
}

export function target(overrides: Partial<ResolvedRemoteUpdateTarget> = {}): ResolvedRemoteUpdateTarget {
  return {
    commonDir: "/canonical/repo.git",
    monitorKey: "monitor-a",
    remoteName: "upstream",
    remoteFingerprint: "fingerprint-a",
    targetRef: "refs/heads/trunk",
    destinationRef: "refs/remotes/upstream/trunk",
    ...overrides
  };
}

export const OID_A = "a".repeat(40);
export const OID_B = "b".repeat(40);

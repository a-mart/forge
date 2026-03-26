import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TerminalMeta } from "@forge/protocol";
import type * as HeadlessModule from "@xterm/headless";
import type * as SerializeModule from "@xterm/addon-serialize";
import headlessPkg from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
import {
  getProfilesDir,
  getSessionsDir,
  getTerminalLogPath,
  getTerminalMetaPath,
  getTerminalSnapshotPath,
} from "../swarm/data-paths.js";

const { Terminal } = headlessPkg as typeof HeadlessModule;
const { SerializeAddon } = serializePkg as typeof SerializeModule;

type HeadlessTerminal = InstanceType<typeof Terminal>;
type HeadlessSerializeAddon = InstanceType<typeof SerializeAddon>;

export interface TerminalJournalEntry {
  seq: number;
  dataBase64: string;
}

export interface TerminalRestoreState {
  replay: Buffer;
  lastSeq: number;
}

export interface TerminalPersistenceOptions {
  dataDir: string;
  scrollbackLines: number;
  journalMaxBytes: number;
}

interface TerminalMirrorRuntime {
  terminal: HeadlessTerminal;
  serializeAddon: HeadlessSerializeAddon;
}

export class TerminalPersistence {
  private readonly dataDir: string;
  private readonly scrollbackLines: number;
  readonly journalMaxBytes: number;
  private readonly mirrors = new Map<string, TerminalMirrorRuntime>();

  constructor(options: TerminalPersistenceOptions) {
    this.dataDir = options.dataDir;
    this.scrollbackLines = options.scrollbackLines;
    this.journalMaxBytes = options.journalMaxBytes;
  }

  createMirror(meta: TerminalMeta): void {
    this.disposeMirror(meta.terminalId);
    this.mirrors.set(meta.terminalId, createHeadlessMirror(meta.cols, meta.rows, this.scrollbackLines));
  }

  async restoreMirror(meta: TerminalMeta): Promise<TerminalRestoreState> {
    this.createMirror(meta);
    return this.restoreTerminalState(meta);
  }

  async writeToMirror(terminalId: string, chunk: Buffer): Promise<void> {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) {
      return;
    }

    await writeToTerminal(mirror.terminal, chunk.toString("utf8"));
  }

  resizeMirror(terminalId: string, cols: number, rows: number): void {
    const mirror = this.mirrors.get(terminalId);
    mirror?.terminal.resize(cols, rows);
  }

  async writeSnapshot(meta: TerminalMeta): Promise<void> {
    const mirror = this.requireMirror(meta.terminalId);
    const snapshot = mirror.serializeAddon.serialize({ scrollback: this.scrollbackLines });
    await atomicWriteFile(getTerminalSnapshotPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), snapshot);
  }

  async appendJournal(meta: TerminalMeta, seq: number, chunk: Buffer): Promise<number> {
    const path = getTerminalLogPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    await mkdir(dirname(path), { recursive: true });
    const line = `${JSON.stringify({ seq, dataBase64: chunk.toString("base64") })}\n`;
    await appendFile(path, line, "utf8");
    return Buffer.byteLength(line, "utf8");
  }

  async truncateJournal(meta: TerminalMeta): Promise<void> {
    const path = getTerminalLogPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, "");
  }

  async readSnapshot(meta: TerminalMeta): Promise<string | null> {
    const path = getTerminalSnapshotPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);

    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  async readJournalDelta(meta: TerminalMeta, afterSeq: number): Promise<TerminalJournalEntry[]> {
    const path = getTerminalLogPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const entries: TerminalJournalEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as Partial<TerminalJournalEntry>;
        if (typeof parsed.seq === "number" && typeof parsed.dataBase64 === "string" && parsed.seq > afterSeq) {
          entries.push({ seq: parsed.seq, dataBase64: parsed.dataBase64 });
        }
      } catch (error) {
        console.warn(`[terminal-persistence] Skipping invalid journal entry for ${meta.terminalId}: ${toErrorMessage(error)}`);
      }
    }

    entries.sort((a, b) => a.seq - b.seq);
    return entries;
  }

  async readReplayData(meta: TerminalMeta): Promise<TerminalRestoreState> {
    const snapshot = await this.readSnapshot(meta);
    const entries = await this.readJournalDelta(meta, meta.checkpointSeq);
    return buildRestoreState(snapshot, entries, meta.checkpointSeq);
  }

  async restoreTerminalState(meta: TerminalMeta): Promise<TerminalRestoreState> {
    const mirror = this.requireMirror(meta.terminalId);
    const snapshot = await this.readSnapshot(meta);
    const entries = await this.readJournalDelta(meta, meta.checkpointSeq);

    if (snapshot) {
      await writeToTerminal(mirror.terminal, snapshot);
    }

    for (const entry of entries) {
      await writeToTerminal(mirror.terminal, Buffer.from(entry.dataBase64, "base64").toString("utf8"));
    }

    return buildRestoreState(snapshot, entries, meta.checkpointSeq);
  }

  async saveMeta(meta: TerminalMeta): Promise<void> {
    const path = getTerminalMetaPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    await atomicWriteFile(path, `${JSON.stringify(meta, null, 2)}\n`);
  }

  async loadMeta(path: string): Promise<TerminalMeta | null> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<TerminalMeta>;
      if (!isTerminalMeta(parsed)) {
        console.warn(`[terminal-persistence] Invalid terminal meta at ${path}`);
        return null;
      }
      return parsed;
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  }

  async listPersistedMeta(): Promise<TerminalMeta[]> {
    const result: TerminalMeta[] = [];
    const profilesDir = getProfilesDir(this.dataDir);

    let profileEntries: string[];
    try {
      profileEntries = await readdir(profilesDir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    for (const profileId of profileEntries) {
      const sessionsDir = getSessionsDir(this.dataDir, profileId);
      let sessionEntries: string[];
      try {
        sessionEntries = await readdir(sessionsDir);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }

      for (const sessionAgentId of sessionEntries) {
        const terminalsDir = join(sessionsDir, sessionAgentId, "terminals");
        let terminalEntries: string[];
        try {
          terminalEntries = await readdir(terminalsDir);
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }

        for (const terminalId of terminalEntries) {
          const meta = await this.loadMeta(
            getTerminalMetaPath(this.dataDir, profileId, sessionAgentId, terminalId),
          );
          if (meta) {
            result.push(meta);
          }
        }
      }
    }

    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return result;
  }

  async getJournalSize(meta: TerminalMeta): Promise<number> {
    const path = getTerminalLogPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    try {
      const stats = await stat(path);
      return stats.size;
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return 0;
      }
      throw error;
    }
  }

  async deleteTerminal(meta: TerminalMeta): Promise<void> {
    const metaPath = getTerminalMetaPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    await rm(dirname(metaPath), { recursive: true, force: true });
    this.disposeMirror(meta.terminalId);
  }

  async moveTerminalScope(meta: TerminalMeta, nextSessionAgentId: string): Promise<void> {
    if (meta.sessionAgentId === nextSessionAgentId) {
      return;
    }

    const currentMetaPath = getTerminalMetaPath(this.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId);
    const nextMetaPath = getTerminalMetaPath(this.dataDir, meta.profileId, nextSessionAgentId, meta.terminalId);
    const currentTerminalDir = dirname(currentMetaPath);
    const nextTerminalDir = dirname(nextMetaPath);

    try {
      await stat(currentTerminalDir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    await mkdir(dirname(nextTerminalDir), { recursive: true });
    await rm(nextTerminalDir, { recursive: true, force: true });
    await rename(currentTerminalDir, nextTerminalDir);

    const updatedMeta: TerminalMeta = {
      ...meta,
      sessionAgentId: nextSessionAgentId,
    };
    await this.saveMeta(updatedMeta);
  }

  disposeMirror(terminalId: string): void {
    const mirror = this.mirrors.get(terminalId);
    mirror?.terminal.dispose();
    this.mirrors.delete(terminalId);
  }

  async flushAll(terminals: TerminalMeta[]): Promise<void> {
    for (const meta of terminals) {
      try {
        await this.writeSnapshot(meta);
      } catch (error) {
        console.warn(`[terminal-persistence] Failed to flush snapshot for ${meta.terminalId}: ${toErrorMessage(error)}`);
      }
    }
  }

  private requireMirror(terminalId: string): TerminalMirrorRuntime {
    const mirror = this.mirrors.get(terminalId);
    if (!mirror) {
      throw new Error(`Missing headless terminal mirror for ${terminalId}`);
    }
    return mirror;
  }
}

function createHeadlessMirror(cols: number, rows: number, scrollback: number): TerminalMirrorRuntime {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  return {
    terminal,
    serializeAddon,
  };
}

async function writeToTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(data, () => resolve());
  });
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

function buildRestoreState(
  snapshot: string | null,
  entries: TerminalJournalEntry[],
  checkpointSeq: number,
): TerminalRestoreState {
  const replayParts: Buffer[] = [];
  if (snapshot) {
    replayParts.push(Buffer.from(snapshot, "utf8"));
  }

  for (const entry of entries) {
    replayParts.push(Buffer.from(entry.dataBase64, "base64"));
  }

  return {
    replay: replayParts.length > 0 ? Buffer.concat(replayParts) : Buffer.alloc(0),
    lastSeq: entries.length > 0 ? entries[entries.length - 1]!.seq : checkpointSeq,
  };
}

function isTerminalMeta(value: Partial<TerminalMeta>): value is TerminalMeta {
  return (
    value.version === 1 &&
    typeof value.terminalId === "string" &&
    typeof value.sessionAgentId === "string" &&
    typeof value.profileId === "string" &&
    typeof value.name === "string" &&
    typeof value.shell === "string" &&
    Array.isArray(value.shellArgs) &&
    typeof value.cwd === "string" &&
    typeof value.cols === "number" &&
    typeof value.rows === "number" &&
    typeof value.state === "string" &&
    typeof value.checkpointSeq === "number" &&
    typeof value.nextSeq === "number" &&
    typeof value.recoveredFromPersistence === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

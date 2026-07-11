/**
 * WP-8: version-labelled Pi v3 JSONL compatibility/recovery fixtures.
 * Uses real SessionManager.open and a test-only frozen 0.71.1 rollback runner alias.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getConversationHistoryCacheFilePath } from "../session/conversation-history-cache.js";
import { HistoryCacheStore } from "../session/history-cache-store.js";
import { appendImmediateCustomEntryViaTimeline, CONVERSATION_ENTRY_TYPE, ConversationTimeline } from "../session/conversation-timeline.js";
import { loadFrozenPi0711SessionModule } from "./helpers/pi-0711-rollback-runner.js";

const FIXTURE_BASE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-sessions");
const FIXTURE_VERSIONS = ["0.71.1", "0.80.6"] as const;
const tempDirs: string[] = [];

interface Manifest {
  piSessionFormatVersion: number;
  forgeBaseline: string;
  forgeCommit: string;
  forgeCommitShort?: string;
  generatedAt?: string;
  generation?: {
    toolchain: string;
    nodeVersion: string;
    method: string;
    integrity: string;
  };
  fixtureHashes?: Record<string, string>;
  fixtures: Array<{ id: string; file: string; sha256?: string }>;
  rollbackPolicy: string;
  targetNativeSemantics?: Record<string, string>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest(version: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(FIXTURE_BASE, version, "manifest.json"), "utf8")) as Manifest;
}

function sessionEntries(entries: FileEntry[]): SessionEntry[] {
  return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function summarize(entries: SessionEntry[]): { ids: string[]; leafId: string | null; types: string[] } {
  return {
    ids: entries.map((entry) => entry.id),
    leafId: entries.at(-1)?.id ?? null,
    types: entries.map((entry) => entry.type),
  };
}

async function copyFixtureToTemp(version: string, file: string): Promise<{ source: string; target: string }> {
  const source = join(FIXTURE_BASE, version, file);
  const root = await mkdtemp(join(tmpdir(), `forge-pi-session-${version}-`));
  tempDirs.push(root);
  const target = join(root, basename(file));
  await writeFile(target, await readFile(source));
  return { source, target };
}

function contextSignature(context: { messages: Array<{ role: string; content?: unknown }>; thinkingLevel: string; model: unknown }): unknown {
  return {
    roles: context.messages.map((message) => message.role),
    thinkingLevel: context.thinkingLevel,
    model: context.model,
    text: context.messages.map((message) => JSON.stringify(message.content ?? null)),
  };
}

describe("pi session fixture compatibility (WP-8)", () => {
  it("declares tracked 0.71.1 and 0.80.6 v3 fixture manifests with rollback policy", async () => {
    for (const version of FIXTURE_VERSIONS) {
      const manifest = await readManifest(version);
      expect(manifest.piSessionFormatVersion).toBe(CURRENT_SESSION_VERSION);
      expect(manifest.forgeBaseline).toBe(version);
      expect(manifest.forgeCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(manifest.forgeCommit).not.toContain("wp-8");
      expect(manifest.generation?.integrity).toBe("sha256-per-fixture");
      expect(manifest.generation?.toolchain).toBe("node");
      expect(manifest.fixtures.map((fixture) => fixture.id)).toEqual([
        "compat-matrix",
        "aborted-stream-tail",
        "interrupted-tool-call",
        "truncated-tail",
        "crash-during-compaction",
      ]);
      expect(manifest.rollbackPolicy).toContain("snapshot");
      expect(manifest.rollbackPolicy).toMatch(/do not downgrade in-place/i);

      for (const fixture of manifest.fixtures) {
        const hash = await sha256File(join(FIXTURE_BASE, version, fixture.file));
        expect(fixture.sha256).toBe(hash);
        expect(manifest.fixtureHashes?.[fixture.id]).toBe(hash);
      }
    }

    const target = await readManifest("0.80.6");
    expect(target.targetNativeSemantics?.thinkingLevels).toContain("max");
    expect(target.targetNativeSemantics?.noneUltraMapping).toMatch(/none|ultra|max/i);
  });

  it("opens labelled fixtures, preserves stable ids/leaves, and covers all required v3 entry shapes", async () => {
    const hashes: Record<string, string> = {};

    for (const version of FIXTURE_VERSIONS) {
      const manifest = await readManifest(version);
      for (const fixture of manifest.fixtures) {
        const path = join(FIXTURE_BASE, version, fixture.file);
        hashes[`${version}:${fixture.id}`] = await sha256File(path);

        const fromFile = sessionEntries(parseSessionEntries(await readFile(path, "utf8")));
        const session = SessionManager.open(path);
        const firstOpen = summarize(session.getEntries());
        const secondOpen = summarize(SessionManager.open(path).getEntries());

        expect(firstOpen).toEqual(secondOpen);
        expect(firstOpen).toEqual(summarize(fromFile));
        expect(session.getSessionId()).toContain(version.replaceAll(".", ""));

        if (fixture.id === "compat-matrix") {
          expect(firstOpen.types).toEqual([
            "message",
            "thinking_level_change",
            "model_change",
            "message",
            "message",
            "custom",
            "custom_message",
            "label",
            "branch_summary",
            "message",
            "thinking_level_change",
            "message",
            "compaction",
          ]);
          expect(session.getLabel("u1")).toBe("baseline-user");
          expect(session.getBranch().map((entry) => entry.id)).toEqual(["u1", "branch-1", "u-branch", "think-ultra", "a-final", "compact-1"]);
        }

        if (fixture.id === "interrupted-tool-call") {
          expect(session.getEntries().some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(false);
        }

        if (fixture.id === "truncated-tail") {
          expect(firstOpen.ids).toEqual(["trunc-u1", "trunc-a1"]);
        }
      }
    }

    expect(Object.values(hashes).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it("proves buildSessionContext is restart-equivalent and does not replay interrupted tool calls", async () => {
    for (const version of FIXTURE_VERSIONS) {
      const compatPath = join(FIXTURE_BASE, version, "compat-matrix.jsonl");
      const first = SessionManager.open(compatPath);
      const second = SessionManager.open(compatPath);
      expect(contextSignature(first.buildSessionContext())).toEqual(contextSignature(second.buildSessionContext()));
      expect(contextSignature(first.buildSessionContext())).toEqual(
        contextSignature(buildSessionContext(first.getEntries(), first.getLeafId())),
      );

      const interrupted = SessionManager.open(join(FIXTURE_BASE, version, "interrupted-tool-call.jsonl"));
      const context = interrupted.buildSessionContext();
      expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(context.messages)).toContain("dangerous_fixture_tool");
      expect(JSON.stringify(context.messages)).toContain("must-not-run");
      expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
    }
  });

  it("opens and appends 0.71.1 state with 0.80.6 without rewriting the old prefix", async () => {
    const manifest = await readManifest("0.71.1");

    for (const fixture of manifest.fixtures.filter((entry) => entry.id !== "truncated-tail")) {
      const { target } = await copyFixtureToTemp("0.71.1", fixture.file);
      const before = await readFile(target, "utf8");
      const session = SessionManager.open(target);
      const appendedId = session.appendMessage({
        role: "user",
        content: [{ type: "text", text: `0.80.6 append to ${fixture.id}` }],
        timestamp: Date.parse("2026-07-11T08:00:00.000Z"),
      });
      const after = await readFile(target, "utf8");

      expect(appendedId).toBeTruthy();
      expect(after.startsWith(before)).toBe(true);
      expect(after.slice(before.length)).toContain(`0.80.6 append to ${fixture.id}`);
    }
  });

  it("recovers readable prefix from truncated tails and fails closed before unsafe immediate append", async () => {
    const { target } = await copyFixtureToTemp("0.71.1", "truncated-tail.jsonl");
    const before = await readFile(target, "utf8");
    const opened = SessionManager.open(target);
    expect(opened.getLeafId()).toBe("trunc-a1");

    await expect(appendImmediateCustomEntryViaTimeline({
      sessionFile: target,
      cwd: "/tmp/pi-fixture-0711-truncated",
      customType: "forge.recovery",
      data: { recovered: true },
      now: () => "2026-07-11T08:30:00.000Z",
    })).rejects.toThrow("invalid trailing session line");
    expect(await readFile(target, "utf8")).toBe(before);
    expect(SessionManager.open(target).getLeafId()).toBe("trunc-a1");
  });

  it("reconstructs Forge timeline/cache entries from v3 session JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-session-cache-"));
    tempDirs.push(root);
    const sessionFile = join(root, "session.jsonl");
    const timeline = new ConversationTimeline({ now: () => "2026-07-11T09:00:00.000Z" });
    const descriptor = { sessionFile, cwd: root };

    const first = timeline.appendConversationEntry(descriptor, {
      type: "conversation_message",
      id: "cm-1",
      agentId: "manager",
      role: "user",
      source: "user_input",
      text: "hello from reconstructed timeline",
      timestamp: "2026-07-11T09:00:00.000Z",
    });
    const second = timeline.appendConversationEntry(descriptor, {
      type: "conversation_message",
      id: "cm-2",
      agentId: "manager",
      role: "assistant",
      source: "assistant_output",
      text: "assistant reconstruction",
      timestamp: "2026-07-11T09:00:01.000Z",
    });

    const restartedTimeline = new ConversationTimeline({ now: () => "2026-07-11T09:00:02.000Z" });
    restartedTimeline.hydrateLeafEntryId({ sessionFile });
    expect(restartedTimeline.getLastSessionEntryId(sessionFile)).toBe(second.entryId);

    const history = SessionManager.open(sessionFile).getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === CONVERSATION_ENTRY_TYPE)
      .map((entry) => entry.data);
    expect(history).toHaveLength(2);

    const store = new HistoryCacheStore({ logDebug: () => undefined });
    const metadata = store.buildMetadata(history, history.length, store.readSessionFileCanonicalStat(sessionFile));
    store.queueCacheSnapshotWrite(sessionFile, history, metadata);
    await store.flushPendingWrites();

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    expect(await readFile(cacheFile, "utf8")).toContain("swarm_conversation_cache_meta");
    const loaded = store.loadConversationHistoryFromCache(sessionFile);
    expect(loaded.cachedHistory?.entries.map((entry) => entry.id)).toEqual(["cm-1", "cm-2"]);
    expect(first.parentId).toBeNull();
    expect(second.parentId).toBe(first.entryId);
  });

  it("opens 0.80.6-written state under the frozen 0.71.1 rollback runner alias", async () => {
    const frozen0711 = await loadFrozenPi0711SessionModule();
    expect(frozen0711, "frozen 0.71.1 runner must be available for WP-8 rollback proof").toBeDefined();
    if (!frozen0711) return;

    expect(frozen0711.CURRENT_SESSION_VERSION).toBe(3);
    const { target } = await copyFixtureToTemp("0.80.6", "compat-matrix.jsonl");
    const current = SessionManager.open(target);
    current.appendMessage({
      role: "user",
      content: [{ type: "text", text: "0.80.6-written rollback probe" }],
      timestamp: Date.parse("2026-07-11T10:00:00.000Z"),
    });

    const old = frozen0711.SessionManager.open(target);
    expect(old.getSessionId()).toBe("fixture-0806-compat");
    expect(old.getEntries().map((entry) => entry.id)).toEqual(SessionManager.open(target).getEntries().map((entry) => entry.id));
    expect(contextSignature(old.buildSessionContext())).toEqual(contextSignature(SessionManager.open(target).buildSessionContext()));
  });

  it("lets the frozen 0.71.1 runner append then 0.80.6 reopen the same session", async () => {
    const frozen0711 = await loadFrozenPi0711SessionModule();
    expect(frozen0711.CURRENT_SESSION_VERSION).toBe(3);

    const { target } = await copyFixtureToTemp("0.71.1", "compat-matrix.jsonl");
    const before = await readFile(target, "utf8");
    const old = frozen0711.SessionManager.open(target);
    const appendedId = old.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old-runner append before target reopen" }],
      timestamp: Date.parse("2026-07-11T10:05:00.000Z"),
    });
    const mid = await readFile(target, "utf8");
    expect(mid.startsWith(before)).toBe(true);
    expect(appendedId).toBeTruthy();

    const current = SessionManager.open(target);
    expect(current.getEntries().map((entry) => entry.id)).toEqual(old.getEntries().map((entry) => entry.id));
    expect(contextSignature(current.buildSessionContext())).toEqual(contextSignature(old.buildSessionContext()));
    expect(JSON.stringify(current.buildSessionContext())).toContain("old-runner append before target reopen");

    const resumedId = current.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "0.80.6 resume after old append" }],
      timestamp: Date.parse("2026-07-11T10:06:00.000Z"),
    });
    expect(resumedId).toBeTruthy();
    const after = await readFile(target, "utf8");
    expect(after.startsWith(mid)).toBe(true);
    expect(SessionManager.open(target).getLeafId()).toBe(resumedId);

    // Bidirectional reopen: frozen runner must still open the 0.80.6-appended file.
    const reopenedOld = frozen0711.SessionManager.open(target);
    expect(reopenedOld.getLeafId()).toBe(resumedId);
    expect(JSON.stringify(reopenedOld.buildSessionContext())).toContain("0.80.6 resume after old append");
    expect(contextSignature(reopenedOld.buildSessionContext())).toEqual(
      contextSignature(SessionManager.open(target).buildSessionContext()),
    );
  });

  it("documents fail-closed snapshot+old-binary rollback when in-place downgrade is unproven", async () => {
    const manifest0711 = await readManifest("0.71.1");
    const manifest0806 = await readManifest("0.80.6");
    for (const manifest of [manifest0711, manifest0806]) {
      expect(manifest.rollbackPolicy).toMatch(/fail closed|snapshot\+old-binary|snapshot-restore-only/i);
      expect(manifest.rollbackPolicy).toMatch(/do not downgrade in-place/i);
    }

    // Positive proof path remains the bidirectional append/reopen tests above.
    // When that proof fails for a future format, operators must retain snapshot + old binary.
    const frozen0711 = await loadFrozenPi0711SessionModule();
    expect(frozen0711.CURRENT_SESSION_VERSION).toBe(3);
    expect(typeof frozen0711.SessionManager.open).toBe("function");
  });
});

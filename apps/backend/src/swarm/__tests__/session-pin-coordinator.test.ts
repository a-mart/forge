import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionDir } from "../data-paths.js";
import { loadPins, savePins, type PinRegistry } from "../message-pins.js";
import {
  SessionPinCoordinator,
  type SessionPinCoordinatorHost,
  type SessionPinOwner,
  type SessionPinRuntime,
} from "../session-pin-coordinator.js";
import type { ConversationEntryEvent } from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionPinCoordinator", () => {
  it("preloads the in-memory index and forgets disposed sessions", async () => {
    const harness = await createHarness();
    const second = owner("session-2", harness.root);
    harness.descriptors.set(second.agentId, second);
    await savePins(harness.sessionDir(harness.owner), registry("m1"));

    await harness.coordinator.preload();

    expect(harness.coordinator.hasPinnedContent(harness.owner.agentId)).toBe(true);
    expect([...harness.coordinator.getPinnedMessageIds(harness.owner.agentId) ?? []]).toEqual(["m1"]);
    expect(harness.coordinator.hasPinnedContent(second.agentId)).toBe(false);

    harness.coordinator.forget(harness.owner.agentId);
    expect(harness.coordinator.getPinnedMessageIds(harness.owner.agentId)).toBeUndefined();
  });

  it("synchronizes persisted content into the index and an explicitly supplied runtime", async () => {
    const harness = await createHarness();
    const runtimeSetPinnedContent = vi.fn();
    await savePins(harness.sessionDir(harness.owner), registry("m1"));

    const loaded = await harness.coordinator.syncPinnedContent(harness.owner, {
      runtime: { setPinnedContent: runtimeSetPinnedContent },
      setPinnedContentOptions: { suppressRecycle: true },
    });

    expect(Object.keys(loaded.pins)).toEqual(["m1"]);
    expect(harness.coordinator.getPinnedMessageIds(harness.owner.agentId)?.has("m1")).toBe(true);
    expect(runtimeSetPinnedContent).toHaveBeenCalledWith(
      expect.stringContaining("Pinned m1"),
      { suppressRecycle: true },
    );
    expect(harness.getRuntime).not.toHaveBeenCalled();
  });

  it("pins and unpins a conversation message in storage-runtime-projector-meta order", async () => {
    const harness = await createHarness();
    harness.histories.set(harness.owner.agentId, [message("m1", "user", "Keep this exact text")]);
    harness.state.runtime = {
      getSystemPrompt: () => "resolved prompt",
      setPinnedContent: async (content) => {
        expect((await loadPins(harness.sessionDir(harness.owner))).pins.m1).toBeDefined();
        expect(content).toContain("Keep this exact text");
        harness.order.push("runtime");
      },
    };

    await expect(harness.coordinator.pinMessage(harness.owner.agentId, "m1", true)).resolves.toEqual({
      pinned: true,
      timestamp: NOW,
    });
    expect(harness.order).toEqual(["runtime", "project:m1:true", "meta:resolved prompt", "log:message:pin"]);
    expect(harness.coordinator.hasPinnedContent(harness.owner.agentId)).toBe(true);

    harness.order.length = 0;
    harness.state.runtime.setPinnedContent = async (content) => {
      expect(content).toBeUndefined();
      harness.order.push("runtime");
    };
    await harness.coordinator.pinMessage(harness.owner.agentId, "m1", false);

    expect(harness.order).toEqual(["runtime", "project:m1:false", "meta:resolved prompt", "log:message:pin"]);
    expect(await loadPins(harness.sessionDir(harness.owner))).toEqual({ version: 1, pins: {} });
    expect(harness.coordinator.hasPinnedContent(harness.owner.agentId)).toBe(false);
  });

  it("rejects pinning an absent or non-pinnable message before side effects", async () => {
    const harness = await createHarness();
    harness.histories.set(harness.owner.agentId, [message("m1", "system", "Not pinnable")]);

    await expect(harness.coordinator.pinMessage(harness.owner.agentId, "m1", true))
      .rejects.toThrow("Message not found or not pinnable: m1");
    expect(harness.order).toEqual([]);
    expect(await loadPins(harness.sessionDir(harness.owner))).toEqual({ version: 1, pins: {} });
  });

  it("clears pins before runtime/meta synchronization and emits each cleared overlay in order", async () => {
    const harness = await createHarness();
    await savePins(harness.sessionDir(harness.owner), registry("m1", "m2"));
    await harness.coordinator.preload();
    harness.state.runtime = {
      getSystemPrompt: () => "prompt after clear",
      setPinnedContent: async (content) => {
        expect(content).toBeUndefined();
        expect(await loadPins(harness.sessionDir(harness.owner))).toEqual({ version: 1, pins: {} });
        harness.order.push("runtime");
      },
    };

    await harness.coordinator.clearAllPins(harness.owner.agentId);

    expect(harness.order).toEqual([
      "runtime",
      "meta:prompt after clear",
      "project:m1:false",
      `emit:m1:false:${NOW}`,
      "project:m2:false",
      `emit:m2:false:${NOW}`,
      "log:message:clear_all_pins",
    ]);
    expect(harness.coordinator.hasPinnedContent(harness.owner.agentId)).toBe(false);

    harness.order.length = 0;
    await harness.coordinator.clearAllPins(harness.owner.agentId);
    expect(harness.order).toEqual(["runtime", "meta:prompt after clear"]);
  });

  it("clears conversation pins with suppressed runtime recycle and no per-message events", async () => {
    const harness = await createHarness();
    await savePins(harness.sessionDir(harness.owner), registry("m1"));
    await harness.coordinator.preload();
    harness.state.runtime = {
      setPinnedContent: (content, options) => {
        expect(content).toBeUndefined();
        expect(options).toEqual({ suppressRecycle: true });
        harness.order.push("runtime:suppressed");
      },
    };

    await harness.coordinator.clearForConversationReset(harness.owner);

    expect(harness.order).toEqual(["runtime:suppressed"]);
    expect(await loadPins(harness.sessionDir(harness.owner))).toEqual({ version: 1, pins: {} });
    expect(harness.coordinator.hasPinnedContent(harness.owner.agentId)).toBe(false);
  });

  it("copies only pins whose messages exist in the forked transcript", async () => {
    const harness = await createHarness();
    const forked = owner("forked", harness.root);
    harness.descriptors.set(forked.agentId, forked);
    await savePins(harness.sessionDir(harness.owner), registry("m1", "m2", "m3"));
    await mkdir(dirname(forked.sessionFile), { recursive: true });
    await writeFile(forked.sessionFile, [
      transcriptLine("entry-1", null, forked.agentId, "m1"),
      transcriptLine("entry-2", "entry-1", forked.agentId, "m2"),
      "",
    ].join("\n"));

    await harness.coordinator.copyPinsForFork(harness.owner, forked);

    expect(Object.keys((await loadPins(harness.sessionDir(forked))).pins)).toEqual(["m1", "m2"]);
    expect([...(harness.coordinator.getPinnedMessageIds(forked.agentId) ?? [])]).toEqual(["m1", "m2"]);
  });

  it("mutates sidebar pin timestamps idempotently and emits one snapshot per call", async () => {
    const harness = await createHarness();

    await expect(harness.coordinator.pinSession(harness.owner.agentId, true)).resolves.toEqual({ pinnedAt: NOW });
    harness.state.now = "2026-07-13T21:00:00.000Z";
    await expect(harness.coordinator.pinSession(harness.owner.agentId, true)).resolves.toEqual({ pinnedAt: NOW });
    await expect(harness.coordinator.pinSession(harness.owner.agentId, false)).resolves.toEqual({ pinnedAt: null });

    expect(harness.emitAgentsSnapshot).toHaveBeenCalledTimes(3);
    expect(harness.descriptors.get(harness.owner.agentId)?.pinnedAt).toBeUndefined();
  });
});

interface Harness {
  root: string;
  owner: SessionPinOwner;
  descriptors: Map<string, SessionPinOwner>;
  histories: Map<string, ConversationEntryEvent[]>;
  state: { runtime?: SessionPinRuntime; now: string };
  order: string[];
  getRuntime: ReturnType<typeof vi.fn>;
  emitAgentsSnapshot: ReturnType<typeof vi.fn>;
  coordinator: SessionPinCoordinator;
  sessionDir: (descriptor: SessionPinOwner) => string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "forge-session-pin-coordinator-"));
  tempRoots.push(root);
  const primary = owner("session-1", root);
  const descriptors = new Map([[primary.agentId, primary]]);
  const histories = new Map<string, ConversationEntryEvent[]>();
  const order: string[] = [];
  const emitAgentsSnapshot = vi.fn(() => order.push("snapshot"));
  const state: Harness["state"] = { now: NOW };

  const host: SessionPinCoordinatorHost = {
    listSessions: () => [...descriptors.values()],
    requireSession: (agentId) => requireDescriptor(descriptors, agentId),
    requireBuilderSession: (agentId) => requireDescriptor(descriptors, agentId),
    assertMutable: (descriptor) => {
      if (descriptor.archivedAt) throw new Error("archived");
    },
    getConversationHistory: (agentId) => histories.get(agentId) ?? [],
    getRuntime: vi.fn(() => state.runtime),
    patchDescriptor: async (agentId, patch) => {
      const updated = patch(requireDescriptor(descriptors, agentId));
      descriptors.set(agentId, updated as SessionPinOwner);
      return updated;
    },
    setConversationMessagePinned: (agentId, messageId, pinned) => {
      expect(agentId).toBe(primary.agentId);
      order.push(`project:${messageId}:${pinned}`);
    },
    captureRuntimePromptMeta: async (_descriptor, prompt) => {
      order.push(`meta:${prompt}`);
    },
    emitMessagePinned: (_agentId, messageId, pinned, timestamp) => {
      order.push(`emit:${messageId}:${pinned}:${timestamp}`);
    },
    emitAgentsSnapshot,
    logDebug: (message) => order.push(`log:${message}`),
  };
  const coordinator = new SessionPinCoordinator({
    dataDir: join(root, "data"),
    now: () => state.now,
    host,
  });
  const harness: Harness = {
    root,
    owner: primary,
    descriptors,
    histories,
    state,
    order,
    getRuntime: host.getRuntime as ReturnType<typeof vi.fn>,
    emitAgentsSnapshot,
    coordinator,
    sessionDir: (descriptor) => getSessionDir(join(root, "data"), descriptor.profileId, descriptor.agentId),
  };
  return harness;
}

function owner(agentId: string, root: string): SessionPinOwner {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "profile-1",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: root,
    model: { provider: "openai-codex", modelId: "gpt-5.4" },
    sessionFile: join(root, "sessions", `${agentId}.jsonl`),
  };
}

function requireDescriptor(descriptors: Map<string, SessionPinOwner>, agentId: string): SessionPinOwner {
  const descriptor = descriptors.get(agentId);
  if (!descriptor) throw new Error(`Unknown session: ${agentId}`);
  return descriptor;
}

function registry(...messageIds: string[]): PinRegistry {
  return {
    version: 1,
    pins: Object.fromEntries(messageIds.map((messageId, index) => [messageId, {
      pinnedAt: `2026-07-13T20:0${index}:00.000Z`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `Pinned ${messageId}`,
      timestamp: `2026-07-13T19:0${index}:00.000Z`,
    }])),
  };
}

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
): ConversationEntryEvent {
  return {
    type: "conversation_message",
    id,
    agentId: "session-1",
    role,
    text,
    timestamp: NOW,
    source: "system",
  };
}

function transcriptLine(entryId: string, parentId: string | null, agentId: string, messageId: string): string {
  return JSON.stringify({
    type: "custom",
    customType: "swarm_conversation_entry",
    id: entryId,
    parentId,
    timestamp: NOW,
    data: {
      type: "conversation_message",
      id: messageId,
      agentId,
      role: "assistant",
      text: `Message ${messageId}`,
      timestamp: NOW,
      source: "system",
    },
  });
}

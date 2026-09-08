import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ActorTaskNotes, TaskNotesStore } from "../task-notes-store.js";
import { SessionGoalStore } from "../goals/session-goal-store.js";
import { SessionPlanStore } from "../planning/session-plan-store.js";
import { PINNED_MESSAGES_FILE_NAME, savePins } from "../session/message-pins.js";
import { getSessionDir } from "../storage/data-paths.js";
import {
  collectUnconsumedToolEvidenceIds,
  createFreshContextHandler,
  formatFreshContextCheckpoint,
  FRESH_CONTEXT_TOO_LARGE_ERROR,
  isFreshContextBusy,
  resolveFreshCheckpointBudget,
} from "../runtime/fresh-context-checkpoint.js";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporaryRoot() {
  const path = await mkdtemp(join(tmpdir(), "forge-fresh-checkpoint-"));
  temporaryRoots.push(path);
  return path;
}

function messageEntry(
  id: string,
  message: Record<string, unknown>,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  } as SessionEntry;
}

describe("fresh context checkpoint helper", () => {
  it.each([20_000, 30_000])("fits a 64K window with %i retained tokens and a larger output capability", async (retainedContextTokens) => {
    const budget = { contextWindow: 64_000, maxOutputTokens: 128_000, retainedContextTokens };
    expect(resolveFreshCheckpointBudget(budget)).toBe(6_592);
    const handler = createFreshContextHandler({
      dataDir: await temporaryRoot(),
      descriptor: { agentId: "s", profileId: "p", role: "manager", managerId: "s" },
      getContextMode: () => "fresh",
      getBudget: () => budget,
    });
    const result = await handler({ reason: "threshold", willRetry: true, tokensBefore: 60_000, branchEntries: [
      messageEntry("original", { role: "user", content: "Finish the authorized work without repeating completed actions." }),
    ] });
    expect(result?.summary).toContain("Active continuation");
    expect(result?.summary).toContain("Finish the authorized work without repeating completed actions.");
    expect(result!.summary.length).toBeLessThanOrEqual(resolveFreshCheckpointBudget(budget));
    expect(result?.details.forgeContext.recoveryNote).toBeDefined();
  });

  it("keeps the existing full checkpoint budget when the output capability fits", () => {
    expect(resolveFreshCheckpointBudget({
      contextWindow: 272_000, maxOutputTokens: 128_000, retainedContextTokens: 30_000,
    })).toBe(8_000);
    expect(resolveFreshCheckpointBudget({
      contextWindow: 32_000, maxOutputTokens: 1_024, retainedContextTokens: 2_000,
    })).toBe(8_000);
  });

  it.each([63_000, 64_000, 65_000])("rejects %i retained tokens when a 64K window cannot fit a safe checkpoint", async (retainedContextTokens) => {
    const dataDir = await temporaryRoot();
    const budget = { contextWindow: 64_000, maxOutputTokens: 128_000, retainedContextTokens };
    expect(resolveFreshCheckpointBudget(budget)).toBe(0);
    const handler = createFreshContextHandler({
      dataDir,
      descriptor: { agentId: "s", profileId: "p", role: "manager", managerId: "s" },
      getContextMode: () => "fresh",
      getBudget: () => budget,
    });
    await expect(handler({ reason: "threshold", willRetry: true, branchEntries: [] })).rejects.toThrow(FRESH_CONTEXT_TOO_LARGE_ERROR);
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" });
    expect((await notes.list()).notes).toEqual([]);
  });

  it("budgets the fresh window without subtracting discarded overflow context", async () => {
    const handler = createFreshContextHandler({
      dataDir: await temporaryRoot(),
      descriptor: { agentId: "s", profileId: "p", role: "manager", managerId: "s" },
      getContextMode: () => "fresh",
      getBudget: () => ({ contextWindow: 32000, maxOutputTokens: 1024, retainedContextTokens: 2000 }),
    });
    const result = await handler({ reason: "overflow", willRetry: true, tokensBefore: 100000, branchEntries: [] });
    expect(result?.summary).toContain("Active overflow obligation");
    expect(result?.tokensBefore).toBe(100000);
  });

  it("rejects busy streaming, tools, and prompt dispatch", () => {
    expect(isFreshContextBusy({ isStreaming: true, promptDispatchPending: false })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false, hasInFlightTools: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false, awaitingAgentSettlement: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false })).toBe(false);
  });

  it("collects trailing unconsumed tool results and ignores later successful consumers", () => {
    const entries = [
      messageEntry("user-1", { role: "user", content: "start" }),
      messageEntry("assistant-1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1" }],
      }),
      messageEntry("result-1", { role: "toolResult", toolCallId: "call-1", content: "old" }),
      messageEntry("assistant-2", {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "consumed" }],
      }),
      messageEntry("assistant-3", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-2" }],
      }),
      messageEntry("result-2", { role: "toolResult", toolCallId: "call-2", content: "keep" }),
    ];

    expect(collectUnconsumedToolEvidenceIds(entries)).toEqual(["result-2"]);
  });

  it("labels overflow as an active obligation and threshold/manual as historical constraints", () => {
    const overflow = formatFreshContextCheckpoint({
      trigger: "overflow",
      willRetry: true,
      overflowObligation: "Keep going on the oversized first input",
      unconsumedToolEvidence: [{
        entryId: "tool-1",
        toolName: "bash",
        resultPreview: "keep",
        ref: {
          sessionAgentId: "session-1",
          actorAgentId: "session-1",
          entryId: "tool-1",
          sourceVersion: "gen",
          byteOffset: 12,
        },
      }],
    });
    expect(overflow).toContain('history({op:"read",ref:');
    expect(overflow).toContain('"entryId":"tool-1"');
    expect(overflow).toContain("Active overflow obligation");
    expect(overflow).toContain("Keep going on the oversized first input");
    expect(overflow).not.toContain("Do not resurrect completed or aborted work");

    const manual = formatFreshContextCheckpoint({
      trigger: "manual",
      willRetry: false,
      unconsumedToolEvidenceIds: [],
    });
    expect(manual).toContain("Do not resurrect completed or aborted work");
    expect(manual).not.toContain("Active overflow obligation");
  });

  it("builds identical checkpoints from native branch plus current goal/plan/pins", async () => {
    const dataDir = await temporaryRoot();
    const descriptor = {
      agentId: "session-1",
      profileId: "profile-1",
      role: "manager" as const,
      managerId: "session-1",
    };
    await new SessionGoalStore({
      dataDir,
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
      now: () => "2026-01-01T00:00:00.000Z",
      randomId: () => "goal-1",
    }).create({ objective: "Ship fresh windows" });
    await new SessionPlanStore({
      dataDir,
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }).update({
      explanation: "Keep the current plan",
      plan: [{ id: "step-1", step: "Write tests", status: "in_progress" }],
    });
    await mkdir(getSessionDir(dataDir, descriptor.profileId, descriptor.agentId), { recursive: true });
    await savePins(getSessionDir(dataDir, descriptor.profileId, descriptor.agentId), {
      version: 1,
      pins: {
        "msg-1": {
          pinnedAt: "2026-01-01T00:00:00.000Z",
          role: "user",
          text: "Never leak secrets",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const branch = [
      messageEntry("user-1", { role: "user", content: "old work" }),
      messageEntry("assistant-1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-9" }],
      }),
      messageEntry("result-9", { role: "toolResult", toolCallId: "call-9", content: "evidence" }),
    ];
    const sessionFile = join(dataDir, "session.jsonl");
    await writeFile(sessionFile, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const handler = createFreshContextHandler({
      dataDir,
      descriptor,
      sessionFile,
      getContextMode: () => "fresh",
    });
    const first = await handler({
      reason: "manual",
      willRetry: false,
      branchEntries: branch,
      tokensBefore: 42,
    });
    const second = await handler({
      reason: "manual",
      willRetry: false,
      branchEntries: branch,
      tokensBefore: 42,
    });

    expect(first?.summary).toBe(second?.summary);
    expect(first?.summary).toContain("Ship fresh windows");
    expect(first?.summary).toContain("Write tests");
    expect(first?.summary).toContain("Never leak secrets");
    expect(first?.summary).toContain('"entryId":"result-9"');
    expect(first?.summary).not.toContain("pendingDeliveries");
    expect(first?.details.forgeContext).toMatchObject({
      mode: "fresh",
      trigger: "manual",
      willRetry: false,
    });
  });

  it("returns undefined in summary mode without building a checkpoint", async () => {
    const handler = createFreshContextHandler({
      dataDir: await temporaryRoot(),
      descriptor: {
        agentId: "session-1",
        profileId: "profile-1",
        role: "manager",
        managerId: "session-1",
      },
      getContextMode: () => "summary",
    });
    await expect(handler({
      reason: "manual",
      willRetry: false,
      branchEntries: [],
    })).resolves.toBeUndefined();
  });

  it("refuses a checkpoint that cannot fit remaining model headroom",
    async () => {
      expect(resolveFreshCheckpointBudget({
        contextWindow: 2_000,
        maxOutputTokens: 1_000,
        retainedContextTokens: 1_900,
      })).toBe(0);
      const handler = createFreshContextHandler({
        dataDir: await temporaryRoot(),
        descriptor: {
          agentId: "session-1",
          profileId: "profile-1",
          role: "manager",
          managerId: "session-1",
          sessionFile: join(tmpdir(), "missing.jsonl"),
        },
        getContextMode: () => "fresh",
        getBudget: () => ({ contextWindow: 2_000, maxOutputTokens: 1_000, retainedContextTokens: 1_900 }),
      });
      await expect(handler({
        reason: "manual",
        willRetry: false,
        branchEntries: [],
        retainedContextTokens: 1_900,
      })).rejects.toThrow(FRESH_CONTEXT_TOO_LARGE_ERROR);
    });
  it.each([
    { name: "default", budget: undefined },
    { name: "64K context cap", budget: { contextWindow: 64_000, maxOutputTokens: 128_000, retainedContextTokens: 30_000 } },
  ])("retains all ten full pins in a readable checkpoint with $name", async ({ budget }) => {
    const dataDir = await temporaryRoot();
    const descriptor = { agentId: "s", profileId: "p", managerId: "s", role: "manager" as const };
    await savePins(getSessionDir(dataDir, "p", "s"), { version: 1, pins: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`p${i}`, {
        role: "user" as const, text: `pin-${i}-start ` + "constraint ".repeat(160) + ` pin-${i}-end`,
        timestamp: "2026-01-01T00:00:00.000Z", pinnedAt: "2026-01-01T00:00:00.000Z",
      }]),
    ) });
    const handler = createFreshContextHandler({ dataDir, descriptor, getContextMode: () => "fresh", getBudget: () => budget ?? {} });
    const result = await handler({ reason: "agent", willRetry: true, branchEntries: [
      messageEntry("first", { role: "user", content: "Build the original requested outcome" }),
      messageEntry("latest", { role: "user", content: "Yes, continue." }),
    ] });
    expect(result!.summary.length).toBeLessThanOrEqual(resolveFreshCheckpointBudget(budget));
    expect(result!.summary).toContain('notes({op:"read",path:"runtime/continuity-0.md"})');
    expect(result!.summary).toContain("Protected pins");
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" });
    const note = await notes.read({ path: "runtime/continuity-0.md", maxChars: 20000 });
    for (let i = 0; i < 10; i++) expect(note.text).toContain(`pin-${i}-end`);
    expect(note.text).toContain("Build the original requested outcome");
    expect(note.text).toContain("Yes, continue.");
    expect(note.text).toContain('op:"items"');
  });

  it("refuses oversized sections without a durable recovery reference instead of slicing them", () => {
    expect(() => formatFreshContextCheckpoint({ trigger: "manual", willRetry: false,
      pins: [{ role: "user", text: "x".repeat(9000) }], maxChars: 8000,
    })).toThrow(FRESH_CONTEXT_TOO_LARGE_ERROR);
  });

  it("refuses to truncate required continuation and recovery instructions even with a recovery note", () => {
    expect(() => formatFreshContextCheckpoint({
      trigger: "threshold", willRetry: true, maxChars: 600,
      recoveryNote: { path: "runtime/continuity-0.md", revision: 1, digest: "a".repeat(64) },
      pins: [{ role: "user", text: "Preserve this authorization boundary." }],
    })).toThrow(FRESH_CONTEXT_TOO_LARGE_ERROR);
  });

  it("refuses missing completed-tool evidence before persisting a reset checkpoint", async () => {
    const dataDir = await temporaryRoot();
    const handler = createFreshContextHandler({ dataDir,
      descriptor: { agentId: "s", profileId: "p", managerId: "s", role: "manager" }, getContextMode: () => "fresh" });
    await expect(handler({ reason: "agent", willRetry: true, branchEntries: [
      messageEntry("tool", { role: "toolResult", toolCallId: "call", toolName: "bash", content: "already completed" }),
    ] })).rejects.toThrow("canonical records are unavailable");
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" });
    expect((await notes.list()).notes).toEqual([]);
  });

  it("rejects unreadable notes and aborts without replacing an existing recovery note", async () => {
    const dataDir = await temporaryRoot();
    const descriptor = { agentId: "s", profileId: "p", managerId: "s", role: "manager" as const };
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" });
    await notes.write({ path: "checkpoint.md", text: "still working" });
    await writeFile(notes.filePath, "{corrupted");
    const handler = createFreshContextHandler({ dataDir, descriptor, getContextMode: () => "fresh" });
    await expect(handler({ reason: "agent", willRetry: true, branchEntries: [] })).rejects.toThrow("cannot read task notes");
    const controller = new AbortController(); controller.abort();
    await expect(handler({ reason: "agent", willRetry: true, branchEntries: [], signal: controller.signal })).rejects.toThrow("aborted");
  });

  it("keeps the committed snapshot intact when preparation is aborted after its write", async () => {
    const dataDir = await temporaryRoot();
    const descriptor = { agentId: "s", profileId: "p", managerId: "s", role: "manager" as const };
    const handler = createFreshContextHandler({ dataDir, descriptor, getContextMode: () => "fresh" });
    const first = await handler({ reason: "manual", willRetry: false, branchEntries: [] });
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" });
    const before = await notes.read({ path: first!.details.forgeContext.recoveryNote!.path });
    const controller = new AbortController();
    const write = ActorTaskNotes.prototype.write;
    const spy = vi.spyOn(ActorTaskNotes.prototype, "write").mockImplementation(async function (this: ActorTaskNotes, options) {
      const result = await write.call(this, options); controller.abort(); return result;
    });
    try {
      await expect(handler({ reason: "agent", willRetry: true, signal: controller.signal, branchEntries: [{
        type: "compaction", id: "committed", parentId: null, timestamp: "2026-01-01T00:00:00Z",
        summary: first!.summary, details: first!.details, tokensBefore: 100,
      } as SessionEntry, messageEntry("next", { role: "user", content: "new steering" })] })).rejects.toThrow("aborted");
    } finally { spy.mockRestore(); }
    expect(await notes.read({ path: before.path })).toEqual(before);
    expect((await notes.read({ path: "runtime/continuity-1.md" })).text).toContain("new steering");
  });

  it("recovers a large original request beyond the recent lookup tail without copying its body", async () => {
    const dataDir = await temporaryRoot();
    const first = messageEntry("first", { role: "user", content: "Original objective " + "x".repeat(150000) });
    const latest = messageEntry("latest", { role: "user", content: "Yes, continue." });
    const sessionFile = join(dataDir, "session.jsonl");
    const filler = JSON.stringify({ type: "custom", id: "filler", data: "y".repeat(60000) });
    await writeFile(sessionFile, JSON.stringify(first) + "\n" + (filler + "\n").repeat(160) + JSON.stringify(latest) + "\n");
    const handler = createFreshContextHandler({ dataDir, sessionFile,
      descriptor: { agentId: "s", profileId: "p", managerId: "s", role: "manager" }, getContextMode: () => "fresh" });
    const result = await handler({ reason: "agent", willRetry: true, branchEntries: [first, latest] });
    expect(result!.summary).toContain('"entryId":"first"');
    expect(result!.summary.length).toBeLessThanOrEqual(8000);
  });

  it("keeps actual user corrections distinct from internal deliveries and redacts argument previews", async () => {
    const dataDir = await temporaryRoot();
    const branch = [
      messageEntry("first", { role: "user", content: '[sourceContext] {"channel":"web"}\nOriginal request' }),
      messageEntry("correction", { role: "user", content: '[sourceContext] {"channel":"web"}\nUse the corrected requirement' }),
      messageEntry("worker", { role: "user", content: "SYSTEM: Worker finished some work" }),
      messageEntry("call", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "test", arguments: { password: "FAKE-SECRET-PREVIEW", safe: "visible" } }] }),
      messageEntry("result", { role: "toolResult", toolCallId: "c", toolName: "test", content: "done" }),
    ];
    const sessionFile = join(dataDir, "session.jsonl");
    await writeFile(sessionFile, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const handler = createFreshContextHandler({ dataDir, sessionFile,
      descriptor: { agentId: "s", profileId: "p", managerId: "s", role: "manager" }, getContextMode: () => "fresh" });
    const result = await handler({ reason: "agent", willRetry: true, branchEntries: branch });
    expect(result!.summary).toContain("Use the corrected requirement");
    expect(result!.summary).not.toContain("Worker finished some work");
    expect(result!.summary).not.toContain("FAKE-SECRET-PREVIEW");
    const note = await new TaskNotesStore({ dataDir }).forActor({ profileId: "p", sessionAgentId: "s", actorAgentId: "s" }).read({ path: "runtime/continuity-0.md" });
    expect(note.text).not.toContain("FAKE-SECRET-PREVIEW");
  });

  it("preserves context when protected pins are corrupt instead of treating them as empty", async () => {
    const dataDir = await temporaryRoot();
    const sessionDir = getSessionDir(dataDir, "p", "s");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, PINNED_MESSAGES_FILE_NAME), '{"version":1,"pins":{"lost":{"role":"invalid"}}}');
    const handler = createFreshContextHandler({ dataDir,
      descriptor: { agentId: "s", profileId: "p", managerId: "s", role: "manager" }, getContextMode: () => "fresh" });
    await expect(handler({ reason: "manual", willRetry: false, branchEntries: [] })).rejects.toThrow("cannot read protected pins");
  });

});

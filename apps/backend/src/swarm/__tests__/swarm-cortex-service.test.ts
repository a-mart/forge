import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CortexReviewRunScope } from "@forge/protocol";
import { appendCortexReviewRun, buildCortexReviewRunRequestText, buildCortexReviewRunScopeLabel, createCortexReviewRunId, readStoredCortexReviewRuns } from "../cortex-review-runs.js";
import { SwarmCortexService } from "../swarm-cortex-service.js";
import type { AgentDescriptor, MessageSourceContext } from "../types.js";

function createReviewDescriptor(agentId: string, label = "Review Run"): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: label,
    role: "manager",
    status: "idle",
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    cwd: "/tmp",
    model: { provider: "openai", modelId: "gpt-test", thinkingLevel: "medium" },
    sessionFile: join("/tmp", `${agentId}.jsonl`),
    profileId: "cortex",
    sessionLabel: label,
    sessionPurpose: "cortex_review",
  };
}

async function makeHarness(options: { handleUserMessage?: (text: string, options?: { targetAgentId?: string; sourceContext?: MessageSourceContext }) => Promise<void> } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-service-"));
  await mkdir(dataDir, { recursive: true });
  const descriptors = new Map<string, AgentDescriptor>();
  let nextSession = 1;
  const handleUserMessage = vi.fn(options.handleUserMessage ?? (async () => undefined));
  const scheduleReviewRunQueueCheckSpy = vi
    .spyOn(SwarmCortexService.prototype, "scheduleReviewRunQueueCheck")
    .mockImplementation(() => undefined);
  const service = new SwarmCortexService({
    config: { cortexEnabled: true, paths: { dataDir } } as any,
    now: () => "2026-03-17T00:00:00.000Z",
    descriptors,
    runtimes: new Map(),
    getWorkersForManager: () => [],
    getConversationHistory: () => [],
    createSession: async (_profileId, createOptions) => {
      const descriptor = createReviewDescriptor(`cortex--s${nextSession++}`, createOptions?.label ?? "Review Run");
      descriptors.set(descriptor.agentId, descriptor);
      return { sessionAgent: descriptor };
    },
    handleUserMessage,
    ensureCortexProfile: async () => undefined,
    sendMessage: async () => ({ delivered: true }) as any,
    logDebug: () => undefined,
  });

  return { dataDir, descriptors, service, handleUserMessage, scheduleReviewRunQueueCheckSpy };
}

async function seedQueuedRun(dataDir: string, scope: CortexReviewRunScope = { mode: "all" }) {
  const run = {
    runId: createCortexReviewRunId(),
    trigger: "manual" as const,
    scope,
    scopeLabel: buildCortexReviewRunScopeLabel(scope),
    requestText: buildCortexReviewRunRequestText(scope),
    requestedAt: "2026-03-17T00:00:00.000Z",
    sessionAgentId: null,
    dispatchState: "queued" as const,
    sourceContext: { channel: "web" as const },
  };
  await appendCortexReviewRun(dataDir, run);
  return run;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwarmCortexService dispatch lifecycle", () => {
  it("recovers crash after createSession before ledger update by attaching marker session and dispatching", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const run = await seedQueuedRun(dataDir);
    const orphan = createReviewDescriptor("cortex--orphan", `Review Run · Full Queue · ${run.runId.slice(0, 12)}`);
    descriptors.set(orphan.agentId, orphan);

    await service.recoverIncompleteReviewRunDispatchesForBoot();

    const [stored] = await readStoredCortexReviewRuns(dataDir);
    expect(stored).toMatchObject({ runId: run.runId, sessionAgentId: orphan.agentId, dispatchState: "dispatched" });
    expect(handleUserMessage).toHaveBeenCalledWith(run.requestText, expect.objectContaining({ targetAgentId: orphan.agentId }));
  });

  it("recovers crash after session_created before handleUserMessage by retry-dispatching", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "session_created", dispatchStartedAt: "2026-03-17T00:01:00.000Z" });

    await service.recoverIncompleteReviewRunDispatchesForBoot();

    expect((await readStoredCortexReviewRuns(dataDir))[0]).toMatchObject({ runId: run.runId, dispatchState: "dispatched" });
    expect(handleUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not treat persisted request text as acceptance proof for ambiguous session_created runs", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "session_created" });

    await service.recoverIncompleteReviewRunDispatchesForBoot();

    expect(handleUserMessage).toHaveBeenCalledTimes(1);
    expect((await readStoredCortexReviewRuns(dataDir))[0]?.dispatchState).toBe("dispatched");
  });

  it("does not duplicate-dispatch when explicit dispatched acceptance is already persisted", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "dispatched", dispatchedAt: "2026-03-17T00:02:00.000Z" });

    await service.recoverIncompleteReviewRunDispatchesForBoot();

    expect(handleUserMessage).not.toHaveBeenCalled();
    expect((await readStoredCortexReviewRuns(dataDir))[0]?.dispatchState).toBe("dispatched");
  });

  it("keeps the reserved session for reuse when handleUserMessage fails", async () => {
    const { dataDir, service } = await makeHarness({ handleUserMessage: async () => { throw new Error("dispatch failed"); } });
    const scope: CortexReviewRunScope = { mode: "all" };

    await expect(service.startReviewRun({ scope, trigger: "manual", sourceContext: { channel: "web" } })).rejects.toThrow("dispatch failed");

    const [failedRun] = await readStoredCortexReviewRuns(dataDir);
    expect(failedRun).toMatchObject({ dispatchState: "queued" });
    expect(failedRun?.sessionAgentId).toMatch(/^cortex--s\d+$/);
  });

  it("blocks repeated dispatch failures instead of retrying forever", async () => {
    const { dataDir, descriptors, service } = await makeHarness({ handleUserMessage: async () => { throw new Error("persistent dispatch failure"); } });
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, {
      ...run,
      sessionAgentId: descriptor.agentId,
      dispatchState: "queued",
      dispatchFailureCount: 2,
    });

    await expect((service as unknown as { startNextQueuedReviewRun: () => Promise<unknown> }).startNextQueuedReviewRun()).rejects.toThrow("persistent dispatch failure");

    expect((await readStoredCortexReviewRuns(dataDir))[0]).toMatchObject({
      runId: run.runId,
      sessionAgentId: descriptor.agentId,
      dispatchState: "queued",
      dispatchFailureCount: 3,
      blockedReason: expect.stringContaining("Review dispatch failed 3 times"),
    });
  });

  it("treats session_created as reserved for scheduled all-scope coalescing", async () => {
    const { dataDir, descriptors, service } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir, { mode: "all" });
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "session_created" });

    await service.startReviewRun({ scope: { mode: "all" }, trigger: "scheduled", sourceContext: { channel: "web" } });

    expect((await readStoredCortexReviewRuns(dataDir)).filter((entry) => entry.scope.mode === "all")).toHaveLength(1);
  });

  it("retries session_created runs during live queue processing", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "session_created" });

    await (service as unknown as { startNextQueuedReviewRun: () => Promise<unknown> }).startNextQueuedReviewRun();

    expect(handleUserMessage).toHaveBeenCalledWith(run.requestText, expect.objectContaining({ targetAgentId: descriptor.agentId }));
    expect((await readStoredCortexReviewRuns(dataDir))[0]).toMatchObject({ sessionAgentId: descriptor.agentId, dispatchState: "dispatched" });
  });

  it("reuses reserved queued sessions during runtime queue processing instead of creating orphans", async () => {
    const { dataDir, descriptors, service, handleUserMessage } = await makeHarness();
    const descriptor = createReviewDescriptor("cortex--s1");
    descriptors.set(descriptor.agentId, descriptor);
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: descriptor.agentId, dispatchState: "queued" });

    await (service as unknown as { startNextQueuedReviewRun: () => Promise<unknown> }).startNextQueuedReviewRun();

    expect(handleUserMessage).toHaveBeenCalledWith(run.requestText, expect.objectContaining({ targetAgentId: descriptor.agentId }));
    expect(Array.from(descriptors.keys())).toEqual([descriptor.agentId]);
    expect((await readStoredCortexReviewRuns(dataDir))[0]).toMatchObject({ sessionAgentId: descriptor.agentId, dispatchState: "dispatched" });
  });

  it("returns missing session_created descriptors to queued/recoverable state", async () => {
    const { dataDir, service, handleUserMessage } = await makeHarness();
    const run = await seedQueuedRun(dataDir);
    await appendCortexReviewRun(dataDir, { ...run, sessionAgentId: "cortex--missing", dispatchState: "session_created" });

    await service.recoverIncompleteReviewRunDispatchesForBoot();

    expect(handleUserMessage).not.toHaveBeenCalled();
    expect((await readStoredCortexReviewRuns(dataDir))[0]).toMatchObject({ sessionAgentId: null, dispatchState: "queued" });
  });
});

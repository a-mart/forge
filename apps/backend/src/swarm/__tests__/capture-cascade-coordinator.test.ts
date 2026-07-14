import type { SessionMeta } from "@forge/protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CaptureCascadeCoordinator,
  type CaptureCascadeDescriptor,
  type CaptureCascadeHost,
} from "../capture-cascade-coordinator.js";
import { getSessionMetaPath } from "../data-paths.js";
import { readSessionMeta, writeSessionMeta } from "../session-manifest.js";

const NOW = "2026-07-13T18:00:00.000Z";
const PROFILE_ID = "profile";
const AGENT_ID = "manager";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CaptureCascadeCoordinator", () => {
  it("gates disabled, non-manager, and capture-check sessions before judging", async () => {
    const fixture = await createFixture();
    fixture.enabled = false;
    await fixture.coordinator.run(AGENT_ID, "compaction");

    fixture.enabled = true;
    fixture.descriptor.role = "worker";
    await fixture.coordinator.run(AGENT_ID, "compaction");

    fixture.descriptor.role = "manager";
    fixture.descriptor.sessionPurpose = "capture_check";
    await fixture.coordinator.run(AGENT_ID, "compaction");

    expect(fixture.executeJudgePrompt).not.toHaveBeenCalled();
    expect(fixture.forkSession).not.toHaveBeenCalled();
  });

  it("logs a cadence skip without moving the watermark", async () => {
    const fixture = await createFixture({ messages: [message("u1", "user", "one turn")] });

    await fixture.coordinator.run(AGENT_ID, "turn");

    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:skipped", {
      agentId: AGENT_ID,
      trigger: "turn",
      skippedReason: "below_threshold",
    });
    expect((await fixture.readMeta()).cortexCaptureLastCheckedAt).toBeUndefined();
  });

  it("honors the persisted daily fork cap before invoking the judge", async () => {
    const fixture = await createFixture({
      messages: userTurns(8),
      meta: { cortexCaptureForksDay: "2026-07-13", cortexCaptureForksToday: 3 },
    });

    await fixture.coordinator.run(AGENT_ID, "turn");

    expect(fixture.executeJudgePrompt).not.toHaveBeenCalled();
    expect(fixture.forkSession).not.toHaveBeenCalled();
    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:skipped", {
      agentId: AGENT_ID,
      trigger: "turn",
      skippedReason: "daily_fork_cap",
    });
  });

  it("advances the watermark when the judge declines capture", async () => {
    const fixture = await createFixture({ messages: userTurns(8) });
    fixture.executeJudgePrompt.mockResolvedValue("NO");

    await fixture.coordinator.run(AGENT_ID, "turn");

    expect(fixture.executeJudgePrompt).toHaveBeenCalledOnce();
    expect(fixture.forkSession).not.toHaveBeenCalled();
    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:judge_no", {
      agentId: AGENT_ID,
      trigger: "turn",
      raw: "NO",
    });
    expect((await fixture.readMeta()).cortexCaptureLastCheckedAt).toBe(NOW);
  });

  it("fails open on a judge error while advancing the watermark", async () => {
    const fixture = await createFixture({ messages: userTurns(8) });
    fixture.executeJudgePrompt.mockRejectedValue(new Error("model unavailable"));

    await expect(fixture.coordinator.run(AGENT_ID, "turn")).resolves.toBeUndefined();

    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:judge_error", {
      agentId: AGENT_ID,
      trigger: "turn",
      message: "model unavailable",
    });
    expect((await fixture.readMeta()).cortexCaptureLastCheckedAt).toBe(NOW);
  });

  it("fails open when the session delta cannot be read", async () => {
    const fixture = await createFixture();
    await rm(fixture.sessionFile);

    await expect(fixture.coordinator.run(AGENT_ID, "compaction")).resolves.toBeUndefined();

    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:read_delta_error", {
      agentId: AGENT_ID,
      message: expect.stringContaining("ENOENT"),
    });
    expect(fixture.executeJudgePrompt).not.toHaveBeenCalled();
    expect((await fixture.readMeta()).cortexCaptureLastCheckedAt).toBe(NOW);
  });

  it("runs a positive judge through the temporary fork lifecycle and records the daily fork", async () => {
    const fixture = await createFixture({ messages: userTurns(8) });
    fixture.executeJudgePrompt.mockResolvedValue("YES: remember this preference");

    await fixture.coordinator.run(AGENT_ID, "turn");

    expect(fixture.forkSession).toHaveBeenCalledWith(AGENT_ID, {
      label: "Capture check",
      fromMessageId: "u8",
    });
    expect(fixture.sendRestrictedTurn).toHaveBeenCalledWith(
      "capture-fork",
      expect.stringContaining("Judge hint: remember this preference"),
      { allowedTools: ["knowledge", "save_learning"], reason: "capture_check" },
    );
    expect(fixture.discardFork).toHaveBeenCalledWith("capture-fork");

    const meta = await fixture.readMeta();
    expect(meta.cortexCaptureLastCheckedAt).toBe(NOW);
    expect(meta.cortexCaptureForksDay).toBe("2026-07-13");
    expect(meta.cortexCaptureForksToday).toBe(1);
  });

  it("discards a failed temporary fork and logs without moving the source watermark", async () => {
    const fixture = await createFixture({ messages: userTurns(8) });
    fixture.executeJudgePrompt.mockResolvedValue("YES: capture it");
    fixture.sendRestrictedTurn.mockRejectedValue(new Error("send failed"));

    await expect(fixture.coordinator.run(AGENT_ID, "turn")).resolves.toBeUndefined();

    expect(fixture.discardFork).toHaveBeenCalledWith("capture-fork");
    expect(fixture.logDebug).toHaveBeenCalledWith("cortex:capture:fork_error", {
      agentId: AGENT_ID,
      trigger: "turn",
      message: "send failed",
    });
    const meta = await fixture.readMeta();
    expect(meta.cortexCaptureLastCheckedAt).toBeUndefined();
    expect(meta.cortexCaptureForksToday).toBeUndefined();
  });

  it("routes matching feedback directly to a fork and ignores a mismatched profile", async () => {
    const fixture = await createFixture({ messages: [message("u1", "user", "feedback context")] });

    await fixture.coordinator.handleFeedbackSignal("other-profile", AGENT_ID);
    expect(fixture.forkSession).not.toHaveBeenCalled();

    await fixture.coordinator.handleFeedbackSignal(PROFILE_ID, AGENT_ID);

    expect(fixture.executeJudgePrompt).not.toHaveBeenCalled();
    expect(fixture.sendRestrictedTurn).toHaveBeenCalledWith(
      "capture-fork",
      expect.stringContaining("Judge hint: user feedback signal"),
      { allowedTools: ["knowledge", "save_learning"], reason: "capture_check" },
    );
  });

  it("moves the watermark after an explicit learning is saved", async () => {
    const fixture = await createFixture();

    await fixture.coordinator.noteLearningSaved(AGENT_ID);

    expect((await fixture.readMeta()).cortexCaptureLastCheckedAt).toBe(NOW);
  });
});

async function createFixture(options: { messages?: string[]; meta?: Partial<SessionMeta> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "capture-cascade-coordinator-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, `${(options.messages ?? []).join("\n")}\n`, "utf8");
  await mkdir(dirname(getSessionMetaPath(dataDir, PROFILE_ID, AGENT_ID)), { recursive: true });
  await writeSessionMeta(dataDir, { ...sessionMeta(), ...options.meta });

  const descriptor: CaptureCascadeDescriptor = {
    agentId: AGENT_ID,
    profileId: PROFILE_ID,
    role: "manager",
    sessionFile,
    updatedAt: "2026-07-13T17:50:00.000Z",
  };
  const descriptors = new Map<string, CaptureCascadeDescriptor>([[AGENT_ID, descriptor]]);
  let enabled = true;
  const executeJudgePrompt = vi.fn(async () => "NO");
  const forkSession = vi.fn(async () => ({ sessionAgentId: "capture-fork" }));
  const sendRestrictedTurn = vi.fn(async () => {});
  const discardFork = vi.fn(async () => {});
  const logDebug = vi.fn();
  const host: CaptureCascadeHost = {
    getDescriptor: (agentId) => descriptors.get(agentId),
    executeJudgePrompt,
    forkSession,
    sendRestrictedTurn,
    discardFork,
  };
  const coordinator = new CaptureCascadeCoordinator({
    dataDir,
    isEnabled: () => enabled,
    host,
    now: () => NOW,
    logDebug,
  });

  return {
    coordinator,
    descriptor,
    descriptors,
    executeJudgePrompt,
    forkSession,
    sendRestrictedTurn,
    discardFork,
    logDebug,
    sessionFile,
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    async readMeta() {
      const meta = await readSessionMeta(dataDir, PROFILE_ID, AGENT_ID);
      if (!meta) throw new Error("Expected session meta fixture");
      return meta;
    },
  };
}

function sessionMeta(): SessionMeta {
  return {
    sessionId: AGENT_ID,
    profileId: PROFILE_ID,
    label: null,
    model: { provider: "openai-codex", modelId: "gpt-5.4" },
    createdAt: "2026-07-13T17:00:00.000Z",
    updatedAt: "2026-07-13T17:00:00.000Z",
    cwd: "/tmp/project",
    promptFingerprint: null,
    promptComponents: null,
    workers: [],
    stats: {
      totalWorkers: 0,
      activeWorkers: 0,
      totalTokens: { input: null, output: null },
      sessionFileSize: null,
      memoryFileSize: null,
    },
  };
}

function userTurns(count: number): string[] {
  return Array.from({ length: count }, (_, index) => message(`u${index + 1}`, "user", `turn ${index + 1}`));
}

function message(id: string, source: "user" | "assistant", text: string): string {
  return JSON.stringify({ id, source, text, timestamp: "2026-07-13T17:30:00.000Z" });
}

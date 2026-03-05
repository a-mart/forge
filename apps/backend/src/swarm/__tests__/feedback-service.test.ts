import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackEvent, SessionMeta } from "@middleman/protocol";
import { describe, expect, it } from "vitest";
import { getSessionFeedbackPath } from "../data-paths.js";
import { FeedbackService } from "../feedback-service.js";
import { readSessionMeta, writeSessionMeta } from "../session-manifest.js";

describe("feedback-service", () => {
  it("submits feedback and reads it back", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);
    const submitted = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "Nice answer",
      channel: "web",
      actor: "user"
    });

    expect(submitted.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(submitted.createdAt))).toBe(true);

    const feedback = await service.listFeedback(profileId, sessionId);
    expect(feedback).toEqual([submitted]);
  });

  it("resolves latest feedback state per target using last event wins", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    const first = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const second = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "down",
      reasonCodes: ["poor_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const third = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "down",
      reasonCodes: ["instruction_following"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const fourth = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "session",
      targetId: sessionId,
      value: "up",
      reasonCodes: ["great_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const states = await service.getLatestStates(profileId, sessionId);

    expect(states).toEqual([
      {
        targetId: "msg-1",
        scope: "message",
        value: "down",
        latestEventId: third.id,
        latestAt: third.createdAt
      },
      {
        targetId: "msg-2",
        scope: "message",
        value: "down",
        latestEventId: second.id,
        latestAt: second.createdAt
      },
      {
        targetId: sessionId,
        scope: "session",
        value: "up",
        latestEventId: fourth.id,
        latestAt: fourth.createdAt
      }
    ]);

    expect(states.find((state) => state.targetId === "msg-1")?.latestEventId).toBe(third.id);
    expect(states.find((state) => state.targetId === "msg-1")?.latestEventId).not.toBe(first.id);
  });

  it("filters feedback by scope, value, and since", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    const eventA = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const eventB = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "session",
      targetId: sessionId,
      value: "down",
      reasonCodes: ["poor_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const eventC = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "down",
      reasonCodes: ["formatting"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await expect(service.listFeedback(profileId, sessionId, { scope: "message" })).resolves.toEqual([eventA, eventC]);

    await expect(service.listFeedback(profileId, sessionId, { value: "down" })).resolves.toEqual([eventB, eventC]);

    await expect(service.listFeedback(profileId, sessionId, { since: eventB.createdAt })).resolves.toEqual([eventB, eventC]);
  });

  it("queries feedback across sessions", async () => {
    const dataDir = await createTempDataDir();
    const service = new FeedbackService(dataDir);

    const alphaSessionOne = await service.submitFeedback({
      profileId: "alpha",
      sessionId: "alpha--s1",
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["great_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    await service.submitFeedback({
      profileId: "alpha",
      sessionId: "alpha--s2",
      scope: "message",
      targetId: "msg-2",
      value: "down",
      reasonCodes: ["poor_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const betaSessionOne = await service.submitFeedback({
      profileId: "beta",
      sessionId: "beta--s1",
      scope: "session",
      targetId: "beta--s1",
      value: "up",
      reasonCodes: ["great_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const allFeedback = await service.queryFeedbackAcrossSessions();
    expect(allFeedback).toHaveLength(3);

    const alphaFeedback = await service.queryFeedbackAcrossSessions({ profileId: "alpha" });
    expect(alphaFeedback).toHaveLength(2);
    expect(alphaFeedback.every((event) => event.profileId === "alpha")).toBe(true);

    const downVotes = await service.queryFeedbackAcrossSessions({ value: "down" });
    expect(downVotes).toHaveLength(1);
    expect(downVotes[0]?.value).toBe("down");

    expect(allFeedback.map((event) => event.id)).toContain(alphaSessionOne.id);
    expect(allFeedback.map((event) => event.id)).toContain(betaSessionOne.id);
  });

  it("tracks feedback file size and updates session meta fields", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    await writeSessionMeta(dataDir, createSessionMeta(profileId, sessionId));

    const service = new FeedbackService(dataDir);

    const event = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const feedbackPath = getSessionFeedbackPath(dataDir, profileId, sessionId);
    const sizeFromStat = (await stat(feedbackPath)).size;
    const sizeFromService = await service.getFeedbackFileSize(profileId, sessionId);

    expect(sizeFromService).toBe(sizeFromStat);
    expect(sizeFromService).toBeGreaterThan(0);

    const meta = await readSessionMeta(dataDir, profileId, sessionId);
    expect(meta?.feedbackFileSize).toBe(String(sizeFromStat));
    expect(meta?.lastFeedbackAt).toBe(event.createdAt);
  });

  it("handles empty files and skips invalid JSONL lines gracefully", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";
    const feedbackPath = getSessionFeedbackPath(dataDir, profileId, sessionId);

    await mkdir(join(dataDir, "profiles", profileId, "sessions", sessionId), { recursive: true });
    await writeFile(feedbackPath, "", "utf8");

    const service = new FeedbackService(dataDir);

    await expect(service.listFeedback(profileId, sessionId)).resolves.toEqual([]);
    await expect(service.getLatestStates(profileId, sessionId)).resolves.toEqual([]);
    await expect(service.getFeedbackFileSize(profileId, sessionId)).resolves.toBe(0);

    const validOne: FeedbackEvent = {
      id: "event-1",
      createdAt: "2026-03-04T00:00:00.000Z",
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "",
      channel: "web",
      actor: "user"
    };

    const validTwo: FeedbackEvent = {
      id: "event-2",
      createdAt: "2026-03-04T00:00:01.000Z",
      profileId,
      sessionId,
      scope: "session",
      targetId: sessionId,
      value: "down",
      reasonCodes: ["poor_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    };

    await writeFile(
      feedbackPath,
      [
        JSON.stringify(validOne),
        "not-json",
        JSON.stringify({ bad: true }),
        JSON.stringify({ ...validTwo, reasonCodes: ["unknown_reason"] }),
        JSON.stringify(validTwo)
      ].join("\n") + "\n",
      "utf8"
    );

    const parsed = await service.listFeedback(profileId, sessionId);
    expect(parsed).toEqual([validOne, validTwo]);
  });
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "feedback-service-"));
  return join(root, "data");
}

function createSessionMeta(profileId: string, sessionId: string): SessionMeta {
  return {
    sessionId,
    profileId,
    label: null,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex"
    },
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    cwd: "/tmp/project",
    promptFingerprint: null,
    promptComponents: null,
    workers: [],
    stats: {
      totalWorkers: 0,
      activeWorkers: 0,
      totalTokens: {
        input: null,
        output: null
      },
      sessionFileSize: null,
      memoryFileSize: null
    }
  };
}

async function delayMs(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

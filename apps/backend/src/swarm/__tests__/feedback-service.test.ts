import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeedbackEvent, FeedbackSubmitEvent, SessionMeta } from "@forge/protocol";
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

  it("stores vote and comment entries independently for the same target", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    await service.submitFeedback({
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

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    const both = await service.listFeedback(profileId, sessionId);
    expect(both).toHaveLength(2);
    expect(both.map((event) => event.value).sort()).toEqual(["comment", "up"]);
  });

  it("clearKind comment removes only the comment entry", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    await service.submitFeedback({
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

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user",
      clearKind: "comment"
    });

    const remaining = await service.listFeedback(profileId, sessionId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.value).toBe("up");
  });

  it("clearKind vote (or default clear) removes only the vote entry", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    await service.submitFeedback({
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

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    // Explicit vote-clear
    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user",
      clearKind: "vote"
    });

    const remainingAfterVoteClear = await service.listFeedback(profileId, sessionId);
    expect(remainingAfterVoteClear).toHaveLength(1);
    expect(remainingAfterVoteClear[0]?.value).toBe("comment");

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "up",
      reasonCodes: ["accuracy"],
      comment: "Nice answer",
      channel: "web",
      actor: "user"
    });

    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "comment",
      reasonCodes: ["accuracy"],
      comment: "I like this answer",
      channel: "web",
      actor: "user"
    });

    // Default clear (defaults to vote)
    await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const remainingAfterDefaultClear = await service.listFeedback(profileId, sessionId);
    expect(remainingAfterDefaultClear).toHaveLength(2);
    expect(remainingAfterDefaultClear.every((event) => event.value === "comment")).toBe(true);
    expect(remainingAfterDefaultClear.map((event) => event.targetId)).toContain("msg-1");
    expect(remainingAfterDefaultClear.map((event) => event.targetId)).toContain("msg-2");
  });

  it("accepts needs_clarification for both up and down feedback", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    const up = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "up",
      reasonCodes: ["needs_clarification"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    await delayMs(5);

    const down = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-2",
      value: "down",
      reasonCodes: ["needs_clarification"],
      comment: "",
      channel: "web",
      actor: "user"
    });

    const feedback = await service.listFeedback(profileId, sessionId);
    expect(feedback).toHaveLength(2);
    expect(feedback.find((event) => event.id === up.id)?.reasonCodes).toContain("needs_clarification");
    expect(feedback.find((event) => event.id === down.id)?.reasonCodes).toContain("needs_clarification");
  });

  it("rejects empty comments for comment feedback", async () => {
    const dataDir = await createTempDataDir();
    const service = new FeedbackService(dataDir);

    await expect(
      service.submitFeedback({
        profileId: "alpha",
        sessionId: "alpha--s1",
        scope: "message",
        targetId: "msg-1",
        value: "comment",
        reasonCodes: ["accuracy"],
        comment: "   \n\t",
        channel: "web",
        actor: "user"
      })
    ).rejects.toThrow("comment must be a non-empty string.");
  });

  it("upserts existing feedback entries and removes entries on clear", async () => {
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
      comment: "Original",
      channel: "web",
      actor: "user"
    });

    const updated = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "down",
      reasonCodes: ["instruction_following"],
      comment: "Updated",
      channel: "web",
      actor: "user"
    });

    const afterUpdate = await service.listFeedback(profileId, sessionId);
    expect(afterUpdate).toEqual([updated]);
    expect(afterUpdate[0]?.id).toBe(updated.id);
    expect(afterUpdate[0]?.id).not.toBe(first.id);

    const feedbackPath = getSessionFeedbackPath(dataDir, profileId, sessionId);
    const rawAfterUpdate = (await readFile(feedbackPath, "utf8")).trim();
    expect(rawAfterUpdate.split("\n").length).toBe(1);
    expect(rawAfterUpdate).toContain(updated.id);

    const cleared = await service.submitFeedback({
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "clear",
      reasonCodes: [],
      comment: "",
      channel: "web",
      actor: "user"
    });

    expect(cleared.value).toBe("clear");

    const afterClear = await service.listFeedback(profileId, sessionId);
    expect(afterClear).toEqual([]);

    const states = await service.getLatestStates(profileId, sessionId);
    expect(states).toEqual([]);

    const sizeFromStat = (await stat(feedbackPath)).size;
    expect(sizeFromStat).toBe(0);

    expect(await readFile(feedbackPath, "utf8")).toBe("");
  });

  it("resolves latest feedback state per target from current stored entries", async () => {
    const dataDir = await createTempDataDir();
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    const service = new FeedbackService(dataDir);

    await service.submitFeedback({
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

    await service.submitFeedback({
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

    await service.submitFeedback({
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

    await service.submitFeedback({
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

    const msgOne = states.find((state) => state.targetId === "msg-1");
    expect(msgOne?.value).toBe("down");

    expect(states.map((state) => state.targetId)).toEqual(["msg-1", "msg-2", sessionId]);
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

    const legacyClear: FeedbackSubmitEvent = {
      id: "event-3",
      createdAt: "2026-03-04T00:00:02.000Z",
      profileId,
      sessionId,
      scope: "message",
      targetId: "msg-1",
      value: "clear",
      reasonCodes: ["poor_outcome"],
      comment: "",
      channel: "web",
      actor: "user"
    };

    await writeFile(
      feedbackPath,
      [JSON.stringify(validOne), "not-json", JSON.stringify({ bad: true }), JSON.stringify(validTwo), JSON.stringify(legacyClear)].join(
        "\n"
      ) + "\n",
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

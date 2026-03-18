import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OnboardingState } from "@forge/protocol";
import type { SwarmConfig } from "../swarm/types.js";
import { getCommonKnowledgePath, getSessionFilePath, getSharedAuthFilePath } from "../swarm/data-paths.js";
import {
  activateOnboardingForEligibleTurn,
  getOnboardingSnapshot,
  loadOnboardingState,
  markOnboardingFirstPromptSent,
  renderOnboardingCommonKnowledge,
  saveOnboardingFacts,
  setOnboardingStatus
} from "../swarm/onboarding-state.js";
import { resolveOnboardingManagerModelDescriptor } from "../swarm/model-presets.js";

describe("onboarding-state", () => {
  it("fresh load creates the default state file", async () => {
    const dataDir = await createTempDataDir();

    const state = await loadOnboardingState(dataDir);

    expect(state).toMatchObject({
      schemaVersion: 2,
      status: "not_started",
      revision: 0,
      owner: {
        ownerId: "primary",
        authUserId: null,
        displayName: null
      },
      sourceSessionId: "cortex"
    });
    expect(state.cycleId).toMatch(/^onb_/);
  });

  it("activates onboarding without marking the first prompt until the greeting is dispatched", async () => {
    const dataDir = await createTempDataDir();

    const activated = await activateOnboardingForEligibleTurn(dataDir);
    expect(activated.status).toBe("active");
    expect(activated.startedAt).toMatch(/T/);
    expect(activated.firstPromptSentAt).toBeNull();

    const marked = await markOnboardingFirstPromptSent(dataDir);
    expect(marked.firstPromptSentAt).toMatch(/T/);

    const markedAgain = await markOnboardingFirstPromptSent(dataDir);
    expect(markedAgain.firstPromptSentAt).toBe(marked.firstPromptSentAt);
  });

  it("accepts CAS fact writes with the correct revision and cycle", async () => {
    const dataDir = await createTempDataDir();
    const initial = await loadOnboardingState(dataDir);

    const result = await saveOnboardingFacts(
      dataDir,
      {
        preferredName: {
          value: "Adam",
          status: "confirmed"
        }
      },
      initial.cycleId,
      initial.revision
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected successful onboarding fact save")
    }

    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.status).toBe("active");
    expect(result.snapshot.captured.preferredName).toMatchObject({
      value: "Adam",
      status: "confirmed"
    });
  });

  it("rejects stale revisions during CAS writes", async () => {
    const dataDir = await createTempDataDir();
    const initial = await loadOnboardingState(dataDir);

    await saveOnboardingFacts(
      dataDir,
      {
        preferredName: {
          value: "Adam",
          status: "confirmed"
        }
      },
      initial.cycleId,
      initial.revision
    );

    const stale = await saveOnboardingFacts(
      dataDir,
      {
        responseVerbosity: {
          value: "concise",
          status: "confirmed"
        }
      },
      initial.cycleId,
      initial.revision
    );

    expect(stale).toMatchObject({
      ok: false,
      reason: "stale_revision"
    });
  });

  it("rejects stale cycle ids during CAS writes", async () => {
    const dataDir = await createTempDataDir();
    const initial = await loadOnboardingState(dataDir);

    const stale = await saveOnboardingFacts(
      dataDir,
      {
        explanationDepth: {
          value: "standard",
          status: "confirmed"
        }
      },
      `${initial.cycleId}-stale`,
      initial.revision
    );

    expect(stale).toMatchObject({
      ok: false,
      reason: "stale_cycle"
    });
  });

  it("persists status transitions with timestamps", async () => {
    const dataDir = await createTempDataDir();
    const initial = await loadOnboardingState(dataDir);

    const active = await setOnboardingStatus(dataDir, "active", null, initial.cycleId, initial.revision);
    expect(active.ok).toBe(true);
    if (!active.ok) {
      throw new Error("Expected active transition to succeed")
    }
    expect(active.snapshot.startedAt).toMatch(/T/);

    const completed = await setOnboardingStatus(
      dataDir,
      "completed",
      "Enough signal captured",
      active.snapshot.cycleId,
      active.snapshot.revision
    );

    expect(completed.ok).toBe(true);
    if (!completed.ok) {
      throw new Error("Expected completed transition to succeed")
    }
    expect(completed.snapshot.status).toBe("completed");
    expect(completed.snapshot.completedAt).toMatch(/T/);
  });

  it("marks meaningful existing installs as migrated", async () => {
    const dataDir = await createTempDataDir();
    await mkdir(join(dataDir, "profiles", "alpha", "sessions", "alpha"), { recursive: true });
    await writeFile(getSessionFilePath(dataDir, "alpha", "alpha"), '{"type":"message"}\n', "utf8");
    await mkdir(dirname(getCommonKnowledgePath(dataDir)), { recursive: true });
    await writeFile(getCommonKnowledgePath(dataDir), "# Common Knowledge\n\n- already learned something\n", "utf8");

    const state = await loadOnboardingState(dataDir);

    expect(state.status).toBe("migrated");
    expect(state.migrationReason).toContain("existing non-Cortex profiles detected");
  });

  it("renders onboarding managed blocks into common.md and updates them in place", async () => {
    const dataDir = await createTempDataDir();
    const commonKnowledgePath = getCommonKnowledgePath(dataDir);
    await mkdir(dirname(commonKnowledgePath), { recursive: true });
    await writeFile(
      commonKnowledgePath,
      "# Common Knowledge\n<!-- Maintained by Cortex. Last updated: 2026-03-18T00:00:00.000Z -->\n\n## Interaction Defaults\n\nManual content stays here.\n",
      "utf8"
    );

    const initial = await loadOnboardingState(dataDir);
    const saved = await saveOnboardingFacts(
      dataDir,
      {
        preferredName: { value: "Ada", status: "promoted" },
        responseVerbosity: { value: "concise", status: "confirmed" }
      },
      initial.cycleId,
      initial.revision
    );
    if (!saved.ok) {
      throw new Error("Expected onboarding fact save to succeed")
    }

    await renderOnboardingCommonKnowledge(dataDir, saved.snapshot);
    const firstRender = await readFile(commonKnowledgePath, "utf8");
    expect(firstRender).toContain("## User Snapshot");
    expect(firstRender).toContain("<!-- BEGIN MANAGED:ONBOARDING -->");
    expect(firstRender).toContain("Preferred name (promoted): Ada");
    expect(firstRender).toContain("Manual content stays here.");

    const updatedSnapshot: OnboardingState = {
      ...saved.snapshot,
      captured: {
        ...saved.snapshot.captured,
        preferredName: {
          ...saved.snapshot.captured.preferredName,
          value: "Ava",
          status: "confirmed"
        }
      }
    };
    await renderOnboardingCommonKnowledge(dataDir, updatedSnapshot);

    const secondRender = await readFile(commonKnowledgePath, "utf8");
    expect(secondRender.match(/BEGIN MANAGED:ONBOARDING/g)).toHaveLength(1);
    expect(secondRender).toContain("Preferred name (confirmed): Ava");
    expect(secondRender).not.toContain("Preferred name (promoted): Ada");
  });

  it("returns the current authoritative snapshot", async () => {
    const dataDir = await createTempDataDir();
    const initial = await loadOnboardingState(dataDir);

    const saved = await saveOnboardingFacts(
      dataDir,
      {
        updateCadence: {
          value: "periodic",
          status: "confirmed"
        }
      },
      initial.cycleId,
      initial.revision
    );
    if (!saved.ok) {
      throw new Error("Expected onboarding fact save to succeed")
    }

    const snapshot = await getOnboardingSnapshot(dataDir);
    expect(snapshot.revision).toBe(saved.snapshot.revision);
    expect(snapshot.captured.updateCadence).toMatchObject({
      value: "periodic",
      status: "confirmed"
    });
  });

  it("prefers Opus for onboarding when Anthropic auth is configured", async () => {
    const dataDir = await createTempDataDir();
    const authPath = getSharedAuthFilePath(dataDir);
    await mkdir(dirname(authPath), { recursive: true });
    const authStorage = AuthStorage.create(authPath);
    authStorage.set("anthropic", {
      type: "api_key",
      key: "sk-ant-test",
      access: "sk-ant-test",
      refresh: "",
      expires: ""
    } as any);

    const model = await resolveOnboardingManagerModelDescriptor(makeModelConfig(dataDir));
    expect(model).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "xhigh"
    });
  });

  it("falls back to GPT-5.4 for onboarding when Anthropic auth is unavailable", async () => {
    const dataDir = await createTempDataDir();

    const model = await resolveOnboardingManagerModelDescriptor(makeModelConfig(dataDir));
    expect(model).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "xhigh"
    });
  });
});

async function createTempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "onboarding-state-"));
}

function makeModelConfig(dataDir: string): Pick<SwarmConfig, "paths"> {
  const sharedAuthFile = getSharedAuthFilePath(dataDir)
  return {
    paths: {
      sharedAuthFile,
      authFile: sharedAuthFile,
    },
  } as Pick<SwarmConfig, "paths">
}

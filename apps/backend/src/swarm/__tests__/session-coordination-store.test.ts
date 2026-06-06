import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORK_PLAN_ITEM_RESULT_STATUSES,
  WORK_PLAN_ITEM_STATUSES,
  WORK_PLAN_LIFECYCLE_REASONS,
  WORK_PLAN_LINK_TYPES,
  WORK_PLAN_MODES,
  WORK_PLAN_STATUSES,
  WORK_PLAN_TERMINAL_STATUSES
} from "@forge/protocol";
import { getSessionTasksPath } from "../storage/data-paths.js";
import {
  SessionCoordinationStateRevisionConflictError,
  SessionCoordinationStore,
  SessionCoordinationStoreUnavailableError
} from "../coordination/session-coordination-store.js";
import {
  INTERNAL_WORK_PLAN_TERMINAL_STATUSES,
  INTERNAL_WORK_PLAN_ITEM_RESULT_STATUSES,
  INTERNAL_WORK_PLAN_ITEM_STATUSES,
  INTERNAL_WORK_PLAN_LIFECYCLE_REASONS,
  INTERNAL_WORK_PLAN_LINK_TYPES,
  INTERNAL_WORK_PLAN_MODES,
  INTERNAL_WORK_PLAN_STATUSES,
  MAX_WORK_PLAN_TITLE_LENGTH,
  MAX_WORK_PLAN_WORKER_LINKS,
  SessionCoordinationStateValidationError,
  createEmptySessionCoordinationState,
  type WorkPlanRecord
} from "../coordination/session-coordination-state.js";

const PROFILE_ID = "profile-a";
const SESSION_ID = "session-a";
const FIXED_TIMESTAMP = "2026-05-29T12:00:00.000Z";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session-coordination-store", () => {
  it("keeps backend-private vocabularies aligned with the current public protocol", () => {
    expect(INTERNAL_WORK_PLAN_STATUSES).toEqual(WORK_PLAN_STATUSES);
    expect(INTERNAL_WORK_PLAN_ITEM_STATUSES).toEqual(WORK_PLAN_ITEM_STATUSES);
    expect(INTERNAL_WORK_PLAN_MODES).toEqual(WORK_PLAN_MODES);
    expect(INTERNAL_WORK_PLAN_ITEM_RESULT_STATUSES).toEqual(WORK_PLAN_ITEM_RESULT_STATUSES);
    expect(INTERNAL_WORK_PLAN_TERMINAL_STATUSES).toEqual(WORK_PLAN_TERMINAL_STATUSES);
    expect(INTERNAL_WORK_PLAN_LIFECYCLE_REASONS).toEqual(WORK_PLAN_LIFECYCLE_REASONS);
    expect(INTERNAL_WORK_PLAN_LINK_TYPES).toEqual(WORK_PLAN_LINK_TYPES);
  });

  it("loads default state without writing when the sidecar is missing", async () => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    const store = createStore(dataDir);

    const result = await store.load();

    expect(result.state).toEqual(createEmptySessionCoordinationState());
    expect(result.diagnostics).toEqual({ state: "defaulted" });
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes pretty json and loads it back", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);

    const saved = await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [createPlan("Build store foundation")]
    });

    expect(saved.state.revision).toBe(1);
    expect(saved.state.updatedAt).toBe(FIXED_TIMESTAMP);
    expect(saved.diagnostics).toEqual({ state: "ok" });

    const raw = await readFile(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(saved.state);

    await expect(store.load()).resolves.toEqual({
      state: saved.state,
      diagnostics: { state: "ok" }
    });
  });

  it.each([8, 24, 100])("loads valid tasks.json with %i retained Work Plans", async (planCount) => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    const workPlans = Array.from({ length: planCount }, (_, index) => {
      const timestamp = new Date(Date.parse(FIXED_TIMESTAMP) + index * 60_000).toISOString();
      return createPlan(`Historical plan ${index + 1}`, {
        planId: `plan-${index + 1}`,
        status: "completed",
        completedAt: timestamp,
        updatedAt: timestamp
      });
    });
    await writeSessionFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, revision: planCount, updatedAt: FIXED_TIMESTAMP, workPlans })
    );
    const store = createStore(dataDir);

    const loaded = await store.load();

    expect(loaded.diagnostics).toEqual({ state: "ok" });
    expect(loaded.state.workPlans).toHaveLength(planCount);
    expect(loaded.state.workPlans[0]?.planId).toBe("plan-1");
  });

  it("serializes concurrent updates so both mutations persist", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);

    const [first, second] = await Promise.all([
      store.update((current) => ({
        ...current,
        workPlans: [...current.workPlans, createPlan("First plan")]
      })),
      store.update((current) => ({
        ...current,
        workPlans: [...current.workPlans, createPlan("Second plan", { planId: "plan-2", status: "completed" })]
      }))
    ]);

    const loaded = await store.load();
    expect(first.state.revision).toBe(1);
    expect(second.state.revision).toBe(2);
    expect(loaded.state.revision).toBe(2);
    expect(loaded.state.workPlans.map((plan) => plan.planId)).toEqual(["plan-1", "plan-2"]);
  });

  it("rejects stale expected revisions without writing", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [createPlan("Initial plan")]
    });

    await expect(
      store.replace(
        {
          ...createEmptySessionCoordinationState(),
          workPlans: [createPlan("Conflicting plan", { planId: "plan-conflict" })]
        },
        { expectedStateRevision: 0 }
      )
    ).rejects.toBeInstanceOf(SessionCoordinationStateRevisionConflictError);

    const loaded = await store.load();
    expect(loaded.state.revision).toBe(1);
    expect(loaded.state.workPlans).toHaveLength(1);
    expect(loaded.state.workPlans[0]?.planId).toBe("plan-1");
  });

  it("backs up malformed json and defaults with a safe diagnostic", async () => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    await writeSessionFile(filePath, "{not-json");
    const store = createStore(dataDir);

    const result = await store.load();

    expect(result.state).toEqual(createEmptySessionCoordinationState());
    expect(result.diagnostics.state).toBe("corrupt_recovered");
    expect(result.diagnostics.message).not.toContain(dataDir);
    expect(result.diagnostics.message).not.toContain(filePath);
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const backupNames = await readdir(dirname(filePath));
    const backupName = backupNames.find((name) => name.startsWith(`${basename(filePath)}.corrupt.`));
    expect(backupName).toBeTruthy();
    await expect(readFile(join(dirname(filePath), backupName!), "utf8")).resolves.toBe("{not-json");
  });

  it("backs up invalid schema and defaults with a safe diagnostic", async () => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    await writeSessionFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, revision: 0, updatedAt: FIXED_TIMESTAMP, workPlans: [] })
    );
    const store = createStore(dataDir);

    const result = await store.load();

    expect(result.state).toEqual(createEmptySessionCoordinationState());
    expect(result.diagnostics.state).toBe("corrupt_recovered");
    const backupNames = await readdir(dirname(filePath));
    expect(backupNames.some((name) => name.startsWith(`${basename(filePath)}.corrupt.`))).toBe(true);
  });

  it("treats corrupt backup failures as unavailable and preserves the original corrupt file", async () => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    await writeSessionFile(filePath, "{not-json");

    const store = createStore(dataDir, {
      renameWithRetry: async () => {
        const error = new Error("backup rename failed");
        (error as Error & { code?: string }).code = "EACCES";
        throw error;
      }
    });

    const loaded = await store.load();
    expect(loaded.state).toEqual(createEmptySessionCoordinationState());
    expect(loaded.diagnostics).toEqual({
      state: "unavailable",
      message: "Session coordination state could not be recovered safely."
    });

    await expect(
      store.replace({
        ...createEmptySessionCoordinationState(),
        workPlans: [createPlan("Should not overwrite corrupt file")]
      })
    ).rejects.toBeInstanceOf(SessionCoordinationStoreUnavailableError);

    await expect(readFile(filePath, "utf8")).resolves.toBe("{not-json");
    const sessionEntries = await readdir(dirname(filePath));
    expect(sessionEntries.some((name) => name.startsWith(`${basename(filePath)}.corrupt.`))).toBe(false);
  });

  it("releases the session lock after validation failures and enforces caps", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);

    await expect(
      store.replace({
        ...createEmptySessionCoordinationState(),
        workPlans: [createPlan("x".repeat(MAX_WORK_PLAN_TITLE_LENGTH + 1))]
      })
    ).rejects.toBeInstanceOf(SessionCoordinationStateValidationError);

    await expect(
      store.replace({
        ...createEmptySessionCoordinationState(),
        workPlans: [
          createPlan("Too many worker links", {
            items: [
              createItem("item-1", {
                workerLinks: Array.from({ length: MAX_WORK_PLAN_WORKER_LINKS + 1 }, (_, index) => ({
                  type: "worker",
                  linkId: `link-${index + 1}`,
                  agentId: `worker-${index + 1}`,
                  linkedAt: FIXED_TIMESTAMP,
                  label: `Worker ${index + 1}`
                }))
              })
            ]
          })
        ]
      })
    ).rejects.toBeInstanceOf(SessionCoordinationStateValidationError);

    const saved = await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [createPlan("Valid plan")]
    });
    expect(saved.state.revision).toBe(1);
  });

  it("uses same-directory temp-file rename for atomic writes", async () => {
    const dataDir = await createDataDir();
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID);
    const renameCalls: Array<{ from: string; to: string }> = [];
    const store = createStore(dataDir, {
      renameWithRetry: async (from, to, options) => {
        renameCalls.push({ from, to });
        const { renameWithRetry } = await import("../retry-rename.js");
        return renameWithRetry(from, to, options);
      }
    });

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [createPlan("Atomic write")]
    });

    expect(renameCalls).toHaveLength(1);
    expect(dirname(renameCalls[0]!.from)).toBe(dirname(filePath));
    expect(renameCalls[0]!.from.endsWith(".tmp")).toBe(true);
    expect(renameCalls[0]!.to).toBe(filePath);
  });

  it("releases the session lock and cleans temp files after write failures", async () => {
    const dataDir = await createDataDir();
    let failRename = true;
    const store = createStore(dataDir, {
      renameWithRetry: async (from, to, options) => {
        if (failRename) {
          const error = new Error("rename failed");
          (error as Error & { code?: string }).code = "EACCES";
          throw error;
        }

        const { renameWithRetry } = await import("../retry-rename.js");
        return renameWithRetry(from, to, options);
      }
    });

    await expect(
      store.replace({
        ...createEmptySessionCoordinationState(),
        workPlans: [createPlan("Write fails first")]
      })
    ).rejects.toThrow("rename failed");

    const sessionDir = dirname(getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID));
    const afterFailureEntries = await readdir(sessionDir);
    expect(afterFailureEntries.filter((name) => name.endsWith(".tmp"))).toEqual([]);

    failRename = false;
    const saved = await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [createPlan("Write succeeds second")]
    });

    expect(saved.state.revision).toBe(1);
  });
});

function createStore(
  dataDir: string,
  deps?: ConstructorParameters<typeof SessionCoordinationStore>[0]["deps"]
): SessionCoordinationStore {
  return new SessionCoordinationStore({
    dataDir,
    profileId: PROFILE_ID,
    sessionAgentId: SESSION_ID,
    deps: {
      now: () => new Date(FIXED_TIMESTAMP),
      ...deps
    }
  });
}

async function createDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "session-coordination-store-"));
  tempDirs.push(dir);
  return dir;
}

function createPlan(title: string, overrides: Partial<WorkPlanRecord> = {}): WorkPlanRecord {
  return {
    planId: overrides.planId ?? "plan-1",
    createdByAgentId: overrides.createdByAgentId ?? "manager-1",
    title,
    ...(overrides.goal === undefined ? {} : { goal: overrides.goal }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP,
    ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
    revision: overrides.revision ?? 0,
    items: overrides.items ?? [createItem("item-1")],
    revisionNotes: overrides.revisionNotes ?? [],
    warnings: overrides.warnings ?? [],
    ...(overrides.finalSummary === undefined ? {} : { finalSummary: overrides.finalSummary }),
    ...(overrides.lifecycle === undefined ? {} : { lifecycle: overrides.lifecycle }),
    mutationProvenance: overrides.mutationProvenance ?? []
  };
}

async function writeSessionFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function createItem(itemId: string, overrides: Partial<WorkPlanRecord["items"][number]> = {}) {
  return {
    itemId,
    title: overrides.title ?? `Item ${itemId}`,
    ...(overrides.phase === undefined ? {} : { phase: overrides.phase }),
    status: overrides.status ?? "todo",
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
    ...(overrides.blocker === undefined ? {} : { blocker: overrides.blocker }),
    ...(overrides.result === undefined ? {} : { result: overrides.result }),
    workerLinks: overrides.workerLinks ?? [],
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP
  };
}

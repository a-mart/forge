import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@forge/protocol";
import type {
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import {
  HostOnlySecret,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-24T12:00:00.000Z";
const MANAGER_A = "manager-a";
const WORKER_A1 = "worker-a1";
const WORKER_A2 = "worker-a2";
const UNSUPPORTED_WORKER = "worker-unsupported";
const ASSIGNMENT_A1 = "assignment-a1";
const ASSIGNMENT_A2 = "assignment-a2";
const PROFILE_A = "profile-a";

describe("Secure Sessions worker principal vertical slice", () => {
  it("starts one isolated principal per eligible team member and attaches defaults independently", async () => {
    const harness = createHarness();
    const projectDefault = await harness.service.createLocalSecureSecret({
      displayAlias: "team/default-token",
      encryptedMaterial: encodedFixture("default-material"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "TEAM_DEFAULT_TOKEN",
      }],
      scope: { kind: "profile", profileId: PROFILE_A },
    });
    await harness.service.setSecureSecretProjectDefault(projectDefault.secretId, {
      profileId: PROFILE_A,
      enabled: true,
    });

    await harness.service.startSecureSession(MANAGER_A);

    const snapshots = await harness.service.listSecureSessionTeamSnapshots(MANAGER_A);
    expect(snapshots.map((snapshot) => snapshot.sessionAgentId)).toEqual([
      MANAGER_A,
      WORKER_A1,
      WORKER_A2,
    ]);
    expect(snapshots).toEqual([
      expect.objectContaining({
        sessionAgentId: MANAGER_A,
        principalKind: "manager",
        ownerManagerAgentId: null,
        workerAssignmentId: null,
      }),
      expect.objectContaining({
        sessionAgentId: WORKER_A1,
        principalKind: "worker",
        ownerManagerAgentId: MANAGER_A,
        workerAssignmentId: ASSIGNMENT_A1,
      }),
      expect.objectContaining({
        sessionAgentId: WORKER_A2,
        principalKind: "worker",
        ownerManagerAgentId: MANAGER_A,
        workerAssignmentId: ASSIGNMENT_A2,
      }),
    ]);
    for (const snapshot of snapshots) {
      expect(snapshot).toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
        leases: [
          expect.objectContaining({
            secretId: projectDefault.secretId,
            grantSource: "project_default",
            status: "active",
          }),
        ],
      }));
    }
    expect(new Set(
      snapshots.flatMap(({ leases }) => leases.map(({ leaseId }) => leaseId)),
    ).size).toBe(3);
    expect(harness.execution.activeTasks).toEqual(new Set([
      MANAGER_A,
      workerTaskId(WORKER_A1, ASSIGNMENT_A1),
      workerTaskId(WORKER_A2, ASSIGNMENT_A2),
    ]));
    expect(harness.execution.ensured).not.toContain("manager-b");
    expect(harness.execution.ensured).not.toContain(
      workerTaskId("worker-b1", "assignment-b1"),
    );
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("worker-b1")!,
    )).toBeUndefined();

    await harness.close();
  });

  it("consumes one-use authority on only the worker that executes", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "team/one-use-token",
      encryptedMaterial: encodedFixture("one-use-material"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "WORKER_ONE_USE_TOKEN",
      }],
      scope: { kind: "profile", profileId: PROFILE_A },
    });
    await harness.service.startSecureSession(MANAGER_A);

    const workerOneGrant = await grantEnvironmentLease(
      harness,
      WORKER_A1,
      secret.secretId,
      "WORKER_ONE_USE_TOKEN",
      "one_use",
    );
    const workerTwoGrant = await grantEnvironmentLease(
      harness,
      WORKER_A2,
      secret.secretId,
      "WORKER_ONE_USE_TOKEN",
      "one_use",
    );
    expect(workerOneGrant.leases[0]!.leaseId).not.toBe(
      workerTwoGrant.leases[0]!.leaseId,
    );

    const workerOneBinding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    );
    expect(workerOneBinding).toBeDefined();
    await workerOneBinding!.executeBash({
      command: "worker-one-command",
      cwd: "/workspace-a",
      onData: () => undefined,
    });

    expect(await harness.service.getSecureSessionSnapshot(WORKER_A1)).toEqual(
      expect.objectContaining({
        environmentStatus: "stopped",
        leases: [expect.objectContaining({
          leaseKind: "one_use",
          status: "consumed",
          remainingUses: 0,
        })],
      }),
    );
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        leases: [expect.objectContaining({
          leaseKind: "one_use",
          status: "active",
          remainingUses: 1,
        })],
      }),
    );
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    )).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )).toBeDefined();
    expect(harness.execution.records.at(-1)).toEqual({
      taskId: workerTaskId(WORKER_A1, ASSIGNMENT_A1),
      environmentNames: ["WORKER_ONE_USE_TOKEN"],
      askpassNames: [],
      ramFilePaths: [],
      hasStdin: false,
    });

    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )!.executeBash({
      command: "worker-two-command",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(
      expect.objectContaining({
        environmentStatus: "stopped",
        leases: [expect.objectContaining({
          leaseKind: "one_use",
          status: "consumed",
          remainingUses: 0,
        })],
      }),
    );

    await harness.close();
  });

  it("attributes requests to the exact worker and rejects cross-principal and stale-assignment approval", async () => {
    const harness = createHarness();
    const saved = await harness.service.createLocalSecureSecret({
      displayAlias: "team/saved-token",
      encryptedMaterial: encodedFixture("saved-material"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "SAVED_WORKER_TOKEN",
      }],
      scope: { kind: "profile", profileId: PROFILE_A },
    });
    const oneUse = await harness.service.createLocalSecureSecret({
      displayAlias: "team/assignment-only-token",
      encryptedMaterial: encodedFixture("assignment-only-material"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "ASSIGNMENT_ONLY_TOKEN",
      }],
      scope: { kind: "profile", profileId: PROFILE_A },
    });
    await harness.service.startSecureSession(MANAGER_A);

    await harness.service.requestSecureSecretAccess(
      WORKER_A1,
      "tool-call-worker-a1",
      {
        displayAlias: saved.displayAlias,
        exposures: [{
          deliveryKind: "environment",
          targetName: "SAVED_WORKER_TOKEN",
        }],
        leaseKind: "task",
        purposeSummary: "Authenticate this worker assignment",
      },
    );
    const workerOneRequest = await harness.service.getSecureSessionSnapshot(WORKER_A1);
    const request = workerOneRequest.pendingRequests[0]!;
    expect(request).toEqual(expect.objectContaining({
      requestedByAgentId: WORKER_A1,
      requestedByDisplayName: WORKER_A1,
      workerAssignmentId: ASSIGNMENT_A1,
    }));
    expect((await harness.service.getSecureSessionSnapshot(MANAGER_A)).pendingRequests)
      .toEqual([]);
    const workerTwoSnapshot = await harness.service.getSecureSessionSnapshot(WORKER_A2);
    expect(workerTwoSnapshot.pendingRequests).toEqual([]);

    await expect(harness.service.resolveSecureAccessRequest(
      WORKER_A2,
      request.requestId,
      {
        baseRevision: workerTwoSnapshot.revision,
        requestId: request.requestId,
        decision: "approve",
      },
    )).rejects.toMatchObject({ code: "SECURE_SECRET_NOT_FOUND" });

    const approved = await harness.service.resolveSecureAccessRequest(
      WORKER_A1,
      request.requestId,
      {
        baseRevision: workerOneRequest.revision,
        requestId: request.requestId,
        decision: "approve",
      },
    );
    expect(approved.pendingRequests).toEqual([]);
    expect(approved.leases).toEqual([
      expect.objectContaining({
        secretId: saved.secretId,
        grantSource: "access_request",
        leaseKind: "task",
        status: "active",
      }),
    ]);
    expect((await harness.service.getSecureSessionSnapshot(WORKER_A2)).leases)
      .toEqual([]);

    await harness.service.requestSecureSecretAccess(
      WORKER_A1,
      "tool-call-stale-assignment",
      {
        displayAlias: "team/not-configured-yet",
        exposures: [{
          deliveryKind: "environment",
          targetName: "FUTURE_WORKER_TOKEN",
        }],
        leaseKind: "task",
        purposeSummary: "Request belongs to assignment A1 only",
      },
    );
    await grantEnvironmentLease(
      harness,
      WORKER_A1,
      oneUse.secretId,
      "ASSIGNMENT_ONLY_TOKEN",
      "one_use",
    );
    const beforeAdvance = await harness.service.getSecureSessionSnapshot(WORKER_A1);
    const staleRequest = beforeAdvance.pendingRequests[0]!;
    setWorkerAssignment(
      harness.descriptors.get(WORKER_A1)!,
      "assignment-a1-next",
    );

    await harness.service.advanceWorkerSecureAssignment(
      WORKER_A1,
      "assignment-a1-next",
    );

    const afterAdvance = await harness.service.getSecureSessionSnapshot(WORKER_A1);
    expect(afterAdvance).toEqual(expect.objectContaining({
      workerAssignmentId: "assignment-a1-next",
      environmentStatus: "ready",
      pendingRequests: [],
    }));
    expect(afterAdvance.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: saved.secretId,
        leaseKind: "task",
        status: "active",
      }),
      expect.objectContaining({
        secretId: oneUse.secretId,
        leaseKind: "one_use",
        status: "revoked",
      }),
    ]));
    expect(harness.execution.destroyed).toContain(
      workerTaskId(WORKER_A1, ASSIGNMENT_A1),
    );
    expect(harness.execution.ensured.at(-1)).toBe(
      workerTaskId(WORKER_A1, "assignment-a1-next"),
    );
    await expect(harness.service.resolveSecureAccessRequest(
      WORKER_A1,
      staleRequest.requestId,
      {
        baseRevision: afterAdvance.revision,
        requestId: staleRequest.requestId,
        decision: "deny",
      },
    )).rejects.toMatchObject({ code: "SECURE_SECRET_NOT_FOUND" });

    await harness.close();
  });

  it("tears down one worker without disturbing siblings and keeps unsupported workers fail-closed", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "team/task-token",
      encryptedMaterial: encodedFixture("task-material"),
      bindings: [{
        deliveryKind: "environment",
        targetName: "WORKER_TASK_TOKEN",
      }],
      scope: { kind: "profile", profileId: PROFILE_A },
    });
    await harness.service.startSecureSession(MANAGER_A);
    await grantEnvironmentLease(
      harness,
      WORKER_A1,
      secret.secretId,
      "WORKER_TASK_TOKEN",
      "task",
    );
    await grantEnvironmentLease(
      harness,
      WORKER_A2,
      secret.secretId,
      "WORKER_TASK_TOKEN",
      "task",
    );

    expect(await harness.service.prepareWorkerForSecureTeam(UNSUPPORTED_WORKER))
      .toBe(false);
    expect(harness.store.getSessionState(UNSUPPORTED_WORKER)).toBeNull();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(UNSUPPORTED_WORKER)!,
    )).toBeUndefined();
    await expect(harness.service.requestSecureSecretAccess(
      UNSUPPORTED_WORKER,
      "unsupported-tool-call",
      {
        displayAlias: secret.displayAlias,
        exposures: [{
          deliveryKind: "environment",
          targetName: "WORKER_TASK_TOKEN",
        }],
        leaseKind: "task",
        purposeSummary: "Unsupported providers cannot request worker authority",
      },
    )).rejects.toMatchObject({ code: "SECURE_BUILDER_ONLY" });

    await harness.service.teardownWorkerSecurePrincipal(WORKER_A1);

    expect(harness.store.getSessionState(WORKER_A1)).toBeNull();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    )).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )).toBeDefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(MANAGER_A)!,
    )).toBeDefined();
    expect(harness.execution.activeTasks).toEqual(new Set([
      MANAGER_A,
      workerTaskId(WORKER_A2, ASSIGNMENT_A2),
    ]));
    expect((await harness.service.listSecureSessionTeamSnapshots(MANAGER_A))
      .map(({ sessionAgentId }) => sessionAgentId)).toEqual([
        MANAGER_A,
        WORKER_A2,
      ]);

    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )!.executeBash({
      command: "sibling-survives-teardown",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(harness.execution.records.at(-1)).toEqual({
      taskId: workerTaskId(WORKER_A2, ASSIGNMENT_A2),
      environmentNames: ["WORKER_TASK_TOKEN"],
      askpassNames: [],
      ramFilePaths: [],
      hasStdin: false,
    });

    await harness.close();
  });
});

type Harness = ReturnType<typeof createHarness>;

async function grantEnvironmentLease(
  harness: Harness,
  workerAgentId: string,
  secretId: string,
  targetName: string,
  leaseKind: "task" | "one_use",
) {
  const before = await harness.service.getSecureSessionSnapshot(workerAgentId);
  return await harness.service.grantSecureSessionLease(workerAgentId, {
    baseRevision: before.revision,
    secretId,
    exposures: [{ deliveryKind: "environment", targetName }],
    leaseKind,
  });
}

function createHarness() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const store = new SecureSessionStore(database, undefined, () => new Date(NOW));
  const descriptors = new Map<string, AgentDescriptor>([
    [MANAGER_A, managerDescriptor(MANAGER_A, PROFILE_A, "/workspace-a")],
    [WORKER_A1, workerDescriptor(
      WORKER_A1,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      ASSIGNMENT_A1,
    )],
    [WORKER_A2, workerDescriptor(
      WORKER_A2,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      ASSIGNMENT_A2,
    )],
    [UNSUPPORTED_WORKER, workerDescriptor(
      UNSUPPORTED_WORKER,
      MANAGER_A,
      PROFILE_A,
      "/workspace-a",
      "assignment-unsupported",
      "claude-sdk",
    )],
    ["manager-b", managerDescriptor("manager-b", "profile-b", "/workspace-b")],
    ["worker-b1", workerDescriptor(
      "worker-b1",
      "manager-b",
      "profile-b",
      "/workspace-b",
      "assignment-b1",
    )],
  ]);
  const execution = new RecordingExecutionBackend();
  const source: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      return {
        material: new HostOnlySecret(input.encryptedMaterial!),
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
  };
  const cipher: SecureVaultCipher & { dispose(): void } = {
    async status() {
      return { available: true };
    },
    async encrypt(bytes) {
      return Buffer.from(bytes);
    },
    async decrypt(bytes) {
      return new HostOnlySecret(bytes);
    },
    dispose() {},
  };
  let nextId = 0;
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource: source,
    bitwardenSource: source,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    listDescriptors: () => [...descriptors.values()],
    hasProfile: (profileId) => [...descriptors.values()]
      .some((descriptor) => descriptor.profileId === profileId),
    isProfileArchived: () => false,
    isSessionArchived: () => false,
    requireBuilderSession: (agentId) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) throw new Error("missing descriptor");
      return descriptor;
    },
    emitSnapshot: () => undefined,
    emitCatalogChanged: () => undefined,
    applyModeRuntimeRecycle: async () => "recycled",
    now: () => NOW,
    createId: () => `worker-vertical-${++nextId}`,
  });
  return {
    service,
    store,
    descriptors,
    execution,
    async close() {
      await service.closeSecureSessions();
    },
  };
}

interface ExecutionRecord {
  taskId: string;
  environmentNames: string[];
  askpassNames: string[];
  ramFilePaths: string[];
  hasStdin: boolean;
}

class RecordingExecutionBackend implements SecureExecutionBackend {
  readonly kind = "recording";
  readonly activeTasks = new Set<string>();
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly records: ExecutionRecord[] = [];

  async probe() {
    return { available: true, code: "available" as const };
  }

  async ensureTask(task: SecureExecutionTask) {
    this.ensured.push(task.taskId);
    this.activeTasks.add(task.taskId);
    return {
      backend: this.kind,
      sandboxId: `sandbox-${task.taskId}`,
    };
  }

  async execute(request: SecureExecutionRequest) {
    if (!this.activeTasks.has(request.task.taskId)) {
      throw new Error("attempted execution without an active worker sandbox");
    }
    this.records.push({
      taskId: request.task.taskId,
      environmentNames: request.delivery?.environment?.map(({ name }) => name) ?? [],
      askpassNames: request.delivery?.askpass?.map(({ targetName }) => targetName) ?? [],
      ramFilePaths: request.delivery?.ramFiles?.map(({ targetPath }) => targetPath) ?? [],
      hasStdin: request.delivery?.stdin !== undefined,
    });
    const stdout = await request.guardOutput({
      stream: "stdout",
      bytes: Buffer.from("safe-worker-output"),
      final: false,
    });
    await request.onOutput?.({ stream: "stdout", bytes: stdout });
    const tail = await request.guardOutput({
      stream: "stdout",
      bytes: Buffer.alloc(0),
      final: true,
    });
    await request.onOutput?.({ stream: "stdout", bytes: tail });
    return {
      exitCode: 0,
      signal: null,
      stdout: Buffer.concat([Buffer.from(stdout), Buffer.from(tail)]),
      stderr: Buffer.alloc(0),
    };
  }

  async destroyTask(task: SecureExecutionTask) {
    this.destroyed.push(task.taskId);
    this.activeTasks.delete(task.taskId);
    return true;
  }

  async recoverOrphans() {
    return { destroyedSandboxIds: [] };
  }
}

function managerDescriptor(
  agentId: string,
  profileId: string,
  cwd: string,
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider: "openai", modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionSurface: "builder",
  } as AgentDescriptor;
}

function workerDescriptor(
  agentId: string,
  managerId: string,
  profileId: string,
  cwd: string,
  assignmentId: string,
  provider = "openai",
): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: "worker",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider, modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionSurface: "builder",
    workerParentContext: {
      schemaVersion: 1,
      assignmentId,
      managerId,
      assignedAt: NOW,
      outputTarget: { kind: "manager" },
    },
  } as AgentDescriptor;
}

function setWorkerAssignment(
  descriptor: AgentDescriptor,
  assignmentId: string,
): void {
  (descriptor as AgentDescriptor & {
    workerParentContext: { assignmentId: string };
  }).workerParentContext.assignmentId = assignmentId;
}

function encodedFixture(label: string): string {
  return Buffer.from(`fixture-${label}`).toString("base64");
}

function workerTaskId(workerAgentId: string, assignmentId: string): string {
  return `${workerAgentId}::${assignmentId}`;
}

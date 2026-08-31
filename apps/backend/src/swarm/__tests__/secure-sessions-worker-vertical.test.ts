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
import type { BitwardenPasswordManagerSource } from "../secure-sessions/sources/bitwarden-password-manager-source.js";
import {
  HostOnlySecret,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { SECURE_OUTPUT_QUARANTINE } from "../secure-sessions/redaction/secure-value-guard.js";
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

function testPasswordManagerCliSummary() {
  return {
    state: "ready" as const,
    source: "system" as const,
    executablePath: "/usr/local/bin/bw",
    configuredExecutablePath: null,
    version: "2026.8.0",
    managedVersion: "2026.8.0",
    canInstall: true,
  };
}

describe("Secure Sessions shared team sandbox vertical slice", () => {
  it("starts one sandbox and one automatic grant for the complete manager team", async () => {
    const harness = createHarness();
    const projectDefault = await createEnvironmentSecret(
      harness,
      "team/default-token",
      "TEAM_DEFAULT_TOKEN",
    );
    await harness.service.setSecureSecretProjectDefault(projectDefault.secretId, {
      profileId: PROFILE_A,
      enabled: true,
    });

    const manager = await harness.service.startSecureSession(MANAGER_A);
    const team = await harness.service.listSecureSessionTeamSnapshots(MANAGER_A);

    expect(manager).toEqual(expect.objectContaining({
      sessionAgentId: MANAGER_A,
      principalKind: "manager",
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      environmentStatus: "ready",
      leases: [
        expect.objectContaining({
          secretId: projectDefault.secretId,
          grantSource: "project_default",
          status: "active",
        }),
      ],
    }));
    expect(team).toEqual([manager]);
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A1)).toEqual(manager);
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(manager);
    expect(harness.store.getSessionState(WORKER_A1)).toBeNull();
    expect(harness.store.getSessionState(WORKER_A2)).toBeNull();
    expect(harness.execution.activeTasks).toEqual(new Set([MANAGER_A]));
    expect(harness.recycles).toEqual([MANAGER_A, WORKER_A1, WORKER_A2]);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    )).toBeDefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(UNSUPPORTED_WORKER)!,
    )).toBeUndefined();

    await harness.close();
  });

  it("lets each worker select from the same manager grants without duplication", async () => {
    const harness = createHarness();
    const first = await createEnvironmentSecret(
      harness,
      "team/first",
      "TEAM_FIRST",
    );
    const second = await createEnvironmentSecret(
      harness,
      "team/second",
      "TEAM_SECOND",
    );
    await harness.service.startSecureSession(MANAGER_A);
    const granted = await grantEnvironmentLeases(harness, [
      {
        secretId: first.secretId,
        targetName: "TEAM_FIRST",
        leaseKind: "task",
      },
      {
        secretId: second.secretId,
        targetName: "TEAM_SECOND",
        leaseKind: "task",
      },
    ]);

    await executeAs(harness, WORKER_A1, "worker-one", ["team/first"]);
    await executeAs(harness, WORKER_A2, "worker-two", ["team/second"]);

    expect(harness.execution.records).toEqual([
      expect.objectContaining({
        taskId: MANAGER_A,
        environmentNames: ["TEAM_FIRST"],
      }),
      expect.objectContaining({
        taskId: MANAGER_A,
        environmentNames: ["TEAM_SECOND"],
      }),
    ]);
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A1)).toEqual(
      await harness.service.getSecureSessionSnapshot(WORKER_A2),
    );
    expect(granted.leases.filter((lease) => lease.status === "active")).toHaveLength(2);
    expect(harness.execution.ensured.every((taskId) => taskId === MANAGER_A)).toBe(true);

    await harness.close();
  });

  it("consumes one-use authority once for the whole manager session", async () => {
    const harness = createHarness();
    const secret = await createEnvironmentSecret(
      harness,
      "team/one-use",
      "TEAM_ONE_USE",
    );
    await harness.service.startSecureSession(MANAGER_A);
    await grantEnvironmentLeases(harness, [{
      secretId: secret.secretId,
      targetName: "TEAM_ONE_USE",
      leaseKind: "one_use",
    }]);
    const destroyCountBeforeUse = harness.execution.destroyed.length;

    await executeAs(harness, WORKER_A1, "consume-once", ["team/one-use"]);

    const manager = await harness.service.getSecureSessionSnapshot(MANAGER_A);
    expect(manager).toEqual(expect.objectContaining({
      environmentStatus: "stopped",
      leases: [expect.objectContaining({
        leaseKind: "one_use",
        status: "consumed",
        remainingUses: 0,
      })],
    }));
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(manager);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    )).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )).toBeUndefined();
    expect(harness.execution.destroyed.slice(destroyCountBeforeUse)).toEqual([
      MANAGER_A,
    ]);

    await harness.close();
  });

  it("stores worker requests in the manager snapshot with safe attribution", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession(MANAGER_A);

    await harness.service.requestSecureSecretAccess(WORKER_A1, "tool-request", {
      displayAlias: "team/requested",
      exposures: [{ deliveryKind: "environment", targetName: "REQUESTED_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Authenticate the delegated deployment",
    });

    const manager = await harness.service.getSecureSessionSnapshot(MANAGER_A);
    expect(manager.pendingRequests).toEqual([
      expect.objectContaining({
        requestedByAgentId: WORKER_A1,
        requestedByDisplayName: WORKER_A1,
        workerAssignmentId: null,
        purposeSummary: "Authenticate the delegated deployment",
      }),
    ]);
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A1)).toEqual(manager);
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(manager);

    await harness.close();
  });

  it("invalidates a stale worker assignment binding without changing shared authority", async () => {
    const harness = createHarness();
    const secret = await createEnvironmentSecret(
      harness,
      "team/stable",
      "TEAM_STABLE",
    );
    await harness.service.startSecureSession(MANAGER_A);
    const granted = await grantEnvironmentLeases(harness, [{
      secretId: secret.secretId,
      targetName: "TEAM_STABLE",
      leaseKind: "task",
    }]);
    const worker = harness.descriptors.get(WORKER_A1)!;
    const staleBinding = harness.service.getSecureRuntimeBinding(worker)!;

    setWorkerAssignment(worker, "assignment-a1-next");
    expect(() => staleBinding.executeBash({
      secretAliases: [],
      command: "stale",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).toThrow("SECURE_OPERATION_FAILED");
    await harness.service.advanceWorkerSecureAssignment(
      WORKER_A1,
      "assignment-a1-next",
    );

    const replacement = harness.service.getSecureRuntimeBinding(worker);
    expect(replacement).toBeDefined();
    await replacement!.executeBash({
      secretAliases: [],
      command: "replacement",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(await harness.service.getSecureSessionSnapshot(MANAGER_A)).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        leases: [
          expect.objectContaining({
            leaseId: granted.leases[0]!.leaseId,
            status: "active",
          }),
        ],
      }),
    );
    expect(harness.execution.ensured).toEqual([MANAGER_A, MANAGER_A]);
    expect(harness.execution.destroyed).toEqual([MANAGER_A]);

    await harness.close();
  });

  it("does not stop or rebuild the shared sandbox when a worker is removed", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession(MANAGER_A);

    harness.descriptors.delete(WORKER_A1);

    expect(harness.execution.destroyed).toEqual([]);
    expect(harness.store.getSessionState(WORKER_A1)).toBeNull();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A2)!,
    )).toBeDefined();
    await executeAs(harness, WORKER_A2, "sibling-after-worker-teardown");

    await harness.close();
  });

  it("rejects workers outside the manager workspace and unsupported runtimes", async () => {
    const harness = createHarness();
    harness.descriptors.set(
      "worker-outside",
      workerDescriptor(
        "worker-outside",
        MANAGER_A,
        PROFILE_A,
        "/workspace-other",
        "assignment-outside",
      ),
    );
    await harness.service.startSecureSession(MANAGER_A);

    expect(await harness.service.prepareWorkerForSecureTeam("worker-outside")).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("worker-outside")!,
    )).toBeUndefined();
    expect(await harness.service.prepareWorkerForSecureTeam(UNSUPPORTED_WORKER)).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(UNSUPPORTED_WORKER)!,
    )).toBeUndefined();
    expect(harness.execution.activeTasks).toEqual(new Set([MANAGER_A]));

    await harness.close();
  });

  it("quarantines secret-bearing output for the complete manager session", async () => {
    const harness = createHarness();
    const secret = await createEnvironmentSecret(
      harness,
      "team/quarantine",
      "TEAM_QUARANTINE",
    );
    await harness.service.startSecureSession(MANAGER_A);
    await grantEnvironmentLeases(harness, [{
      secretId: secret.secretId,
      targetName: "TEAM_QUARANTINE",
      leaseKind: "task",
    }]);
    const output: Buffer[] = [];

    await harness.service.getSecureRuntimeBinding(
      harness.descriptors.get(WORKER_A1)!,
    )!.executeBash({
      secretAliases: ["team/quarantine"],
      command: "emit-first-environment-secret",
      cwd: "/workspace-a",
      onData: (data) => output.push(Buffer.from(data)),
    });

    expect(Buffer.concat(output).toString("utf8")).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(await harness.service.getSecureSessionSnapshot(MANAGER_A)).toEqual(
      expect.objectContaining({ outputState: "quarantined" }),
    );
    expect(await harness.service.getSecureSessionSnapshot(WORKER_A2)).toEqual(
      expect.objectContaining({ outputState: "quarantined" }),
    );

    await harness.close();
  });

  it("admits different workers concurrently into the same sandbox", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession(MANAGER_A);
    harness.execution.blockCommands.add("hold-worker-one");
    harness.execution.blockCommands.add("hold-worker-two");

    const first = executeAs(harness, WORKER_A1, "hold-worker-one");
    const second = executeAs(harness, WORKER_A2, "hold-worker-two");
    await harness.execution.waitForBlockedExecutions(2);

    expect(harness.execution.maxConcurrentExecutions).toBe(2);
    expect(harness.execution.records.slice(-2).map(({ taskId }) => taskId)).toEqual([
      MANAGER_A,
      MANAGER_A,
    ]);
    harness.execution.releaseBlockedExecutions();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { exitCode: 0 },
      { exitCode: 0 },
    ]);

    await harness.close();
  });
});

type Harness = ReturnType<typeof createHarness>;

async function createEnvironmentSecret(
  harness: Harness,
  displayAlias: string,
  targetName: string,
) {
  return await harness.service.createLocalSecureSecret({
    displayAlias,
    encryptedMaterial: encodedFixture(displayAlias),
    bindings: [{ deliveryKind: "environment", targetName }],
    scope: { kind: "profile", profileId: PROFILE_A },
  });
}

async function grantEnvironmentLeases(
  harness: Harness,
  grants: Array<{
    secretId: string;
    targetName: string;
    leaseKind: "task" | "timed" | "one_use";
    durationSeconds?: number;
  }>,
) {
  const before = await harness.service.getSecureSessionSnapshot(MANAGER_A);
  return await harness.service.grantSecureSessionLeases(MANAGER_A, {
    baseRevision: before.revision,
    grants: grants.map((grant) => ({
      secretId: grant.secretId,
      exposures: [{
        deliveryKind: "environment" as const,
        targetName: grant.targetName,
      }],
      leaseKind: grant.leaseKind,
      ...(grant.leaseKind === "timed"
        ? { durationSeconds: grant.durationSeconds ?? 900 }
        : {}),
    })),
  });
}

async function executeAs(
  harness: Harness,
  workerAgentId: string,
  command: string,
  secretAliases: readonly string[] = [],
): Promise<{ exitCode: number | null }> {
  return await harness.service.getSecureRuntimeBinding(
    harness.descriptors.get(workerAgentId)!,
  )!.executeBash({
    secretAliases,
    command,
    cwd: "/workspace-a",
    onData: () => undefined,
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
      "cursor-sdk",
    )],
    ["manager-b", managerDescriptor("manager-b", "profile-b", "/workspace-b")],
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
      return { material: new HostOnlySecret(bytes) };
    },
    dispose() {},
  };
  const recycles: string[] = [];
  let nextId = 0;
  const bitwardenPasswordManagerSource: BitwardenPasswordManagerSource = {
    kind: "bitwarden_password_manager",
    async status() {
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async installCli() {
      return {
        state: "locked",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async unlock() {
      return {
        state: "available",
        accountEmail: null,
        serverUrl: null,
        cli: testPasswordManagerCliSummary(),
      };
    },
    async lock() {},
    async sync() {},
    async listCollections() { return []; },
    async listItems() { return []; },
    async resolve() { throw new Error("unused Password Manager source"); },
    dispose() {},
  };
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource: source,
    bitwardenSource: source,
    bitwardenPasswordManagerSource,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    listDescriptors: () => [...descriptors.values()],
    listProfiles: () => [...new Set(
      [...descriptors.values()].flatMap((descriptor) =>
        descriptor.profileId ? [descriptor.profileId] : []
      ),
    )].map((profileId) => ({ profileId })),
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
    applyModeRuntimeRecycle: async (agentId) => {
      recycles.push(agentId);
      return "recycled";
    },
    now: () => NOW,
    createId: () => `worker-vertical-${++nextId}`,
  });
  return {
    service,
    store,
    descriptors,
    execution,
    recycles,
    async close() {
      await service.closeSecureSessions();
    },
  };
}

interface ExecutionRecord {
  taskId: string;
  environmentNames: string[];
}

class RecordingExecutionBackend implements SecureExecutionBackend {
  readonly kind = "recording";
  readonly activeTasks = new Set<string>();
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly records: ExecutionRecord[] = [];
  readonly blockCommands = new Set<string>();
  maxConcurrentExecutions = 0;
  private concurrentExecutions = 0;
  private blockedExecutionCount = 0;
  private readonly blockedWaiters = new Set<() => void>();
  private readonly blockedReleases = new Set<() => void>();

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
      throw new Error("attempted execution without an active team sandbox");
    }
    this.concurrentExecutions += 1;
    this.maxConcurrentExecutions = Math.max(
      this.maxConcurrentExecutions,
      this.concurrentExecutions,
    );
    const command = request.command.args[1] ?? "";
    this.records.push({
      taskId: request.task.taskId,
      environmentNames:
        request.delivery?.environment?.map(({ name }) => name) ?? [],
    });
    try {
      if (this.blockCommands.has(command)) {
        this.blockedExecutionCount += 1;
        const waiters = [...this.blockedWaiters];
        this.blockedWaiters.clear();
        for (const waiter of waiters) waiter();
        await new Promise<void>((resolve) => this.blockedReleases.add(resolve));
      }
      const rawStdout = command === "emit-first-environment-secret"
        ? Buffer.from(request.delivery?.environment?.[0]?.value ?? [])
        : Buffer.from("safe-worker-output");
      const stdout = await request.guardOutput({
        stream: "stdout",
        bytes: rawStdout,
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
    } finally {
      this.concurrentExecutions -= 1;
    }
  }

  async waitForBlockedExecutions(count: number): Promise<void> {
    if (this.blockedExecutionCount >= count) return;
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.blockedExecutionCount >= count) resolve();
        else this.blockedWaiters.add(check);
      };
      this.blockedWaiters.add(check);
    });
  }

  releaseBlockedExecutions(): void {
    for (const release of this.blockedReleases) release();
    this.blockedReleases.clear();
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

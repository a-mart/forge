import Database from "better-sqlite3";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentDescriptor } from "@forge/protocol";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  removeManagedImage,
  runCommand,
  uniqueManagedName,
} from "../../../../../scripts/secure-sessions-e2e/harness.js";
import {
  canaryNeedles,
  scanDirectory,
  scanNamedBytes,
} from "../../../../../scripts/secure-sessions-e2e/privacy-safe-scan.js";
import {
  DockerSecureExecutionBackend,
  dockerSecureExecutionMetadata,
} from "../secure-sessions/execution/docker-secure-execution-backend.js";
import {
  SECURE_OUTPUT_QUARANTINE,
} from "../secure-sessions/redaction/secure-value-guard.js";
import type {
  SecureRuntimeBinding,
} from "../secure-sessions/runtime/secure-runtime-binding.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type {
  SecureVaultCipher,
} from "../secure-sessions/sources/electron-safe-storage-client.js";
import {
  HostOnlySecret,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-24T12:00:00.000Z";
const PROFILE = "docker-e2e-profile";
const MANAGER = "docker-e2e-manager";
const WORKER_ONE = "docker-e2e-worker-one";
const WORKER_TWO = "docker-e2e-worker-two";
const ASSIGNMENT_ONE = "docker-e2e-assignment-one";
const ASSIGNMENT_TWO = "docker-e2e-assignment-two";
const NEXT_ASSIGNMENT_ONE = "docker-e2e-assignment-one-next";
const MANAGER_VALUE = "FORGE_DOCKER_E2E_MANAGER_VALUE";
const WORKER_ONE_VALUE = "FORGE_DOCKER_E2E_WORKER_ONE_VALUE";
const WORKER_TWO_VALUE = "FORGE_DOCKER_E2E_WORKER_TWO_VALUE";
const WORKER_ONE_ONCE = "FORGE_DOCKER_E2E_WORKER_ONE_ONCE";
const WORKER_TWO_ONCE = "FORGE_DOCKER_E2E_WORKER_TWO_ONCE";
const ALL_VALUE_NAMES = [
  MANAGER_VALUE,
  WORKER_ONE_VALUE,
  WORKER_TWO_VALUE,
  WORKER_ONE_ONCE,
  WORKER_TWO_ONCE,
] as const;

const repositoryRoot = await realpath(resolve(process.cwd(), "../.."));
const daemonProbe = process.platform === "win32"
  ? { exitCode: -1, stdout: Buffer.alloc(0) }
  : await runCommand("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
const dockerAvailable =
  daemonProbe.exitCode === 0 && daemonProbe.stdout.byteLength > 0;
if (process.env.FORGE_REQUIRE_SECURE_DOCKER_E2E === "1" && !dockerAvailable) {
  throw new Error(
    "Secure Sessions worker Docker E2E was required but Docker is unavailable",
  );
}
const dockerSuite = dockerAvailable ? describe.sequential : describe.skip;
const runnerImage = `${uniqueManagedName("worker-runner")}:latest`;
const emergencyCleanups = new Set<() => Promise<void>>();

interface ScopeContainer {
  name: string;
  taskHash: string;
}

interface NamedEvidence {
  path: string;
  bytes: Buffer;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeCanary(label: string): Buffer {
  return Buffer.from(
    `Forge worker Docker E2E/${label}/${randomBytes(18).toString("hex")}?"\\end`,
    "utf8",
  );
}

async function buildRunnerFixtureImage(): Promise<void> {
  const built = await runCommand("docker", [
    "build",
    "--target",
    "runner",
    "--tag",
    runnerImage,
    resolve(repositoryRoot, "scripts/secure-sessions-e2e"),
  ], {
    cwd: repositoryRoot,
    timeoutMs: 180_000,
  });
  if (built.exitCode !== 0) {
    throw new Error("failed to build secure-session worker runner image");
  }
}

function workerTaskId(workerAgentId: string, assignmentId: string): string {
  return `${workerAgentId}::${assignmentId}`;
}

function managerDescriptor(workspacePath: string): AgentDescriptor {
  return {
    agentId: MANAGER,
    managerId: MANAGER,
    displayName: MANAGER,
    role: "manager",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: workspacePath,
    model: { provider: "openai", modelId: "test" },
    sessionFile: join(workspacePath, `${MANAGER}.jsonl`),
    profileId: PROFILE,
    sessionSurface: "builder",
  } as AgentDescriptor;
}

function workerDescriptor(
  agentId: string,
  workspacePath: string,
  assignmentId: string,
): AgentDescriptor {
  return {
    agentId,
    managerId: MANAGER,
    displayName: agentId,
    role: "worker",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: workspacePath,
    model: { provider: "openai", modelId: "test" },
    sessionFile: join(workspacePath, `${agentId}.jsonl`),
    profileId: PROFILE,
    sessionSurface: "builder",
    workerParentContext: {
      schemaVersion: 1,
      assignmentId,
      managerId: MANAGER,
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

function verifiedEnvironmentCommand(
  expected: ReadonlyArray<{ name: string; value: Uint8Array }>,
  absentNames: readonly string[],
  marker: string,
  barrier?: {
    startedPath: string;
    releasePath: string;
  },
): string {
  const expectedDigests = expected.map(({ name, value }) => [
    name,
    sha256(value),
  ]);
  const script = [
    'const {createHash}=require("node:crypto");',
    `const expected=${JSON.stringify(expectedDigests)};`,
    `const absent=${JSON.stringify(absentNames)};`,
    "const ok=expected.every(([name,digest])=>",
    'typeof process.env[name]==="string"',
    '&&createHash("sha256").update(process.env[name]).digest("hex")===digest',
    ")&&absent.every(name=>process.env[name]===undefined);",
    "if(!ok)process.exit(42);",
    ...(barrier
      ? [
          'const fs=require("node:fs");',
          `fs.writeFileSync(${JSON.stringify(
            barrier.startedPath,
          )},"ready",{flag:"wx"});`,
          `while(!fs.existsSync(${JSON.stringify(barrier.releasePath)})){`,
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);",
          "}",
        ]
      : []),
    `process.stdout.write(${JSON.stringify(marker)});`,
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

function fencedSentinelCommand(
  startedPath: string,
  releasePath: string,
  completedPath: string,
): string {
  const script = [
    'const fs=require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(startedPath)},"started",{flag:"wx"});`,
    `while(!fs.existsSync(${JSON.stringify(releasePath)})){`,
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);",
    "}",
    `fs.writeFileSync(${JSON.stringify(completedPath)},"completed",{flag:"wx"});`,
  ].join("");
  return `node -e ${JSON.stringify(script)}`;
}

function writeSentinelCommand(sentinelPath: string): string {
  const script =
    `require("node:fs").writeFileSync(${
      JSON.stringify(sentinelPath)
    },"ran",{flag:"wx"})`;
  return `node -e ${JSON.stringify(script)}`;
}

function reflectedEnvironmentCommand(environmentName: string): string {
  const script =
    `process.stdout.write(process.env[${JSON.stringify(environmentName)}])`;
  return `node -e ${JSON.stringify(script)}`;
}

function absentExcept(...presentNames: string[]): string[] {
  const present = new Set(presentNames);
  return ALL_VALUE_NAMES.filter((name) => !present.has(name));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFiles(
  paths: readonly string[],
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map(async (path) => await fileExists(path))))
      .every(Boolean)) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("timed out waiting for Docker execution barrier");
}

async function listDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listScopeContainers(
  scopeHash: string,
): Promise<ScopeContainer[]> {
  const listed = await runCommand("docker", [
    "ps",
    "--all",
    "--filter",
    `label=${dockerSecureExecutionMetadata.managedLabel}=true`,
    "--filter",
    `label=${dockerSecureExecutionMetadata.scopeLabel}=${scopeHash}`,
    "--format",
    "{{.Names}}",
  ], { timeoutMs: 30_000 });
  expect(listed.exitCode).toBe(0);
  const names = listed.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
  const containers: ScopeContainer[] = [];
  for (const name of names) {
    const inspected = await runCommand("docker", [
      "container",
      "inspect",
      "--format",
      `{{index .Config.Labels ${JSON.stringify(
        dockerSecureExecutionMetadata.taskLabel,
      )}}}`,
      name,
    ], { timeoutMs: 30_000 });
    expect(inspected.exitCode).toBe(0);
    containers.push({
      name,
      taskHash: inspected.stdout.toString("utf8").trim(),
    });
  }
  return containers.sort((left, right) => left.name.localeCompare(right.name));
}

function expectIndependentTasks(
  containers: readonly ScopeContainer[],
  expectedTaskIds: readonly string[],
): void {
  expect(new Set(containers.map(({ name }) => name)).size).toBe(
    expectedTaskIds.length,
  );
  expect(containers.map(({ taskHash }) => taskHash).sort()).toEqual(
    expectedTaskIds.map((taskId) => sha256(taskId)).sort(),
  );
}

async function collectScopeEvidence(
  scopeHash: string,
  phase: string,
): Promise<NamedEvidence[]> {
  const evidence: NamedEvidence[] = [];
  for (const { name } of await listScopeContainers(scopeHash)) {
    for (const [kind, args] of [
      ["inspect", ["container", "inspect", name]],
      ["logs", ["logs", name]],
      ["diff", ["diff", name]],
      [
        "secret-roots",
        [
          "exec",
          name,
          "node",
          "-e",
          [
            'const fs=require("node:fs");',
            'const roots=["/run/forge-secure","/tmp/forge-secure-askpass"];',
            "const records=[];",
            "function walk(path){",
            "let metadata;",
            "try{metadata=fs.lstatSync(path)}catch(error){",
            'if(error&&error.code==="ENOENT"){records.push({path,kind:"missing"});return}',
            "throw error",
            "}",
            "if(metadata.isDirectory()){",
            'records.push({path,kind:"directory",mode:metadata.mode&0o777});',
            "for(const name of fs.readdirSync(path).sort()){",
            'walk(path+"/"+name)',
            "}",
            "}else if(metadata.isFile()){",
            "const bytes=fs.readFileSync(path);",
            'records.push({path,kind:"file",mode:metadata.mode&0o777,',
            'size:bytes.length,contentBase64:bytes.toString("base64")})',
            "}else{records.push({path,kind:\"other\",mode:metadata.mode&0o777})}",
            "}",
            "for(const root of roots)walk(root);",
            "process.stdout.write(JSON.stringify({roots,records}));",
          ].join(""),
        ],
      ],
    ] as const) {
      const result = await runCommand("docker", args, { timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      evidence.push({
        path: `${phase}-${name}-${kind}`,
        bytes: Buffer.concat([result.stdout, result.stderr]),
      });
    }
  }
  return evidence;
}

function requireBinding(
  service: SecureSessionsService,
  descriptor: AgentDescriptor,
): SecureRuntimeBinding {
  const binding = service.getSecureRuntimeBinding(descriptor);
  expect(binding).toBeDefined();
  if (!binding) throw new Error("expected a secure runtime binding");
  return binding;
}

function assertSafeExactOutput(
  output: Buffer,
  needles: readonly Uint8Array[],
  marker: string,
  path: string,
): void {
  const report = scanNamedBytes([{ path, bytes: output }], needles);
  expect(report.totalMatches).toBe(0);
  expect(report.matches).toEqual([]);
  expect(output.equals(Buffer.from(marker))).toBe(true);
}

async function executeAndCapture(
  binding: SecureRuntimeBinding,
  workspacePath: string,
  command: string,
): Promise<{ exitCode: number | null; output: Buffer }> {
  const chunks: Buffer[] = [];
  const result = await binding.executeBash({
    command,
    cwd: workspacePath,
    onData: (data) => chunks.push(Buffer.from(data)),
  });
  return {
    exitCode: result.exitCode,
    output: Buffer.concat(chunks),
  };
}

async function createDockerHarness() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "forge-secure-worker-e2e-"),
  );
  const workspacePath = await realpath(temporaryRoot);
  const scope = uniqueManagedName("worker-scope");
  const scopeHash = sha256(scope).slice(0, 16);
  const heartbeatRoot = resolve(
    tmpdir(),
    "forge-secure-heartbeats",
    scopeHash,
  );
  await rm(heartbeatRoot, { recursive: true, force: true });
  const invocations: string[][] = [];
  const execution = new DockerSecureExecutionBackend({
    image: runnerImage,
    scope,
    heartbeatRoot,
    onDockerInvocation: ({ args }) => invocations.push([...args]),
  });
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const store = new SecureSessionStore(database, undefined, () => new Date(NOW));
  const descriptors = new Map<string, AgentDescriptor>([
    [MANAGER, managerDescriptor(workspacePath)],
    [WORKER_ONE, workerDescriptor(
      WORKER_ONE,
      workspacePath,
      ASSIGNMENT_ONE,
    )],
    [WORKER_TWO, workerDescriptor(
      WORKER_TWO,
      workspacePath,
      ASSIGNMENT_TWO,
    )],
  ]);
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
  const source: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      if (!input.encryptedMaterial) {
        throw new Error("missing encrypted fixture material");
      }
      return {
        material: await cipher.decrypt(input.encryptedMaterial),
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
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
    hasProfile: (profileId) => profileId === PROFILE,
    isProfileArchived: () => false,
    isSessionArchived: () => false,
    requireBuilderSession: (agentId) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) throw new Error("missing Docker E2E descriptor");
      return descriptor;
    },
    emitSnapshot: () => undefined,
    emitCatalogChanged: () => undefined,
    applyModeRuntimeRecycle: async () => "recycled",
    now: () => NOW,
    createId: () => `worker-docker-e2e-${++nextId}`,
  });

  let cleaned = false;
  const cleanup = async (assertNoOrphans: boolean): Promise<void> => {
    if (cleaned) return;
    let verifiedClean = false;
    try {
      await service.closeSecureSessions();
      const remaining = await listScopeContainers(scopeHash);
      const heartbeatEntries = await listDirectoryOrEmpty(heartbeatRoot);
      if (assertNoOrphans) {
        expect(remaining).toEqual([]);
        expect(heartbeatEntries).toEqual([]);
      }
      verifiedClean =
        remaining.length === 0 && heartbeatEntries.length === 0;
    } finally {
      if (!verifiedClean) {
        await execution.recoverOrphans([]).catch(() => undefined);
      }
      await rm(heartbeatRoot, { recursive: true, force: true })
        .catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true })
        .catch(() => undefined);
      cleaned = true;
      emergencyCleanups.delete(forceClose);
    }
  };
  const forceClose = async (): Promise<void> => await cleanup(false);
  emergencyCleanups.add(forceClose);

  return {
    service,
    execution,
    descriptors,
    invocations,
    scopeHash,
    heartbeatRoot,
    workspacePath,
    closeAndAssertNoOrphans: async () => await cleanup(true),
  };
}

type DockerHarness = Awaited<ReturnType<typeof createDockerHarness>>;

async function createEnvironmentSecret(
  harness: DockerHarness,
  alias: string,
  environmentName: string,
  canary: Uint8Array,
) {
  return await harness.service.createLocalSecureSecret({
    displayAlias: `docker-e2e/${alias}`,
    encryptedMaterial: Buffer.from(canary).toString("base64"),
    bindings: [{
      deliveryKind: "environment",
      targetName: environmentName,
    }],
    scope: { kind: "profile", profileId: PROFILE },
  });
}

async function grantEnvironmentLease(
  harness: DockerHarness,
  agentId: string,
  secretId: string,
  environmentName: string,
  leaseKind: "task" | "one_use",
) {
  const before = await harness.service.getSecureSessionSnapshot(agentId);
  return await harness.service.grantSecureSessionLease(agentId, {
    baseRevision: before.revision,
    secretId,
    exposures: [{
      deliveryKind: "environment",
      targetName: environmentName,
    }],
    leaseKind,
  });
}

afterEach(async () => {
  const pending = [...emergencyCleanups];
  await Promise.allSettled(pending.map(async (cleanup) => await cleanup()));
});

dockerSuite(
  `SecureSessionsService-to-Docker worker integration [${
    dockerAvailable ? "available" : "backend_unavailable"
  }]`,
  () => {
    beforeAll(async () => {
      await buildRunnerFixtureImage();
    }, 240_000);

    afterAll(async () => {
      await removeManagedImage(runnerImage);
    }, 60_000);

    it("integrates manager and worker authority with isolated Docker sandboxes", async () => {
      const harness = await createDockerHarness();
      const canaries = {
        manager: makeCanary("manager"),
        workerOne: makeCanary("worker-one"),
        workerTwo: makeCanary("worker-two"),
        workerOneOnce: makeCanary("worker-one-once"),
        workerTwoOnce: makeCanary("worker-two-once"),
      };
      const allCanaries = Object.values(canaries);
      const needles = allCanaries.flatMap((canary) => canaryNeedles(canary));
      const visibleOutputs: NamedEvidence[] = [];
      const dockerEvidence: NamedEvidence[] = [];

      try {
        const managerSecret = await createEnvironmentSecret(
          harness,
          "manager-task",
          MANAGER_VALUE,
          canaries.manager,
        );
        const workerOneSecret = await createEnvironmentSecret(
          harness,
          "worker-one-task",
          WORKER_ONE_VALUE,
          canaries.workerOne,
        );
        const workerTwoSecret = await createEnvironmentSecret(
          harness,
          "worker-two-task",
          WORKER_TWO_VALUE,
          canaries.workerTwo,
        );
        const workerOneOnceSecret = await createEnvironmentSecret(
          harness,
          "worker-one-once",
          WORKER_ONE_ONCE,
          canaries.workerOneOnce,
        );
        const workerTwoOnceSecret = await createEnvironmentSecret(
          harness,
          "worker-two-once",
          WORKER_TWO_ONCE,
          canaries.workerTwoOnce,
        );

        await harness.service.startSecureSession(MANAGER);
        await grantEnvironmentLease(
          harness,
          MANAGER,
          managerSecret.secretId,
          MANAGER_VALUE,
          "task",
        );
        await grantEnvironmentLease(
          harness,
          WORKER_ONE,
          workerOneSecret.secretId,
          WORKER_ONE_VALUE,
          "task",
        );
        await grantEnvironmentLease(
          harness,
          WORKER_TWO,
          workerTwoSecret.secretId,
          WORKER_TWO_VALUE,
          "task",
        );

        const initialScopeContainers = await listScopeContainers(
          harness.scopeHash,
        );
        expectIndependentTasks(
          initialScopeContainers,
          [
            MANAGER,
            workerTaskId(WORKER_ONE, ASSIGNMENT_ONE),
            workerTaskId(WORKER_TWO, ASSIGNMENT_TWO),
          ],
        );
        expect(
          await listDirectoryOrEmpty(harness.heartbeatRoot),
        ).toEqual(initialScopeContainers.map(({ name }) => name).sort());

        const repeatedBindings = new Map([
          [MANAGER, requireBinding(
            harness.service,
            harness.descriptors.get(MANAGER)!,
          )],
          [WORKER_ONE, requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_ONE)!,
          )],
          [WORKER_TWO, requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_TWO)!,
          )],
        ]);
        const repeatedPrincipals = [
          {
            agentId: MANAGER,
            environmentName: MANAGER_VALUE,
            canary: canaries.manager,
          },
          {
            agentId: WORKER_ONE,
            environmentName: WORKER_ONE_VALUE,
            canary: canaries.workerOne,
          },
          {
            agentId: WORKER_TWO,
            environmentName: WORKER_TWO_VALUE,
            canary: canaries.workerTwo,
          },
        ] as const;
        const repeatedExecutions: Array<{
          exitCode: number | null;
          output: Buffer;
          marker: string;
          path: string;
        }> = [];
        for (let round = 0; round < 3; round += 1) {
          const releasePath = join(
            harness.workspacePath,
            `.docker-e2e-round-${round}.release`,
          );
          const startedPaths = repeatedPrincipals.map(({ agentId }) =>
            join(
              harness.workspacePath,
              `.docker-e2e-round-${round}-${agentId}.started`,
            )
          );
          const pending = repeatedPrincipals.map((principal, index) => {
            const marker = `${principal.agentId}-round-${round}`;
            const path = `repeated-${principal.agentId}-${round}`;
            return executeAndCapture(
              repeatedBindings.get(principal.agentId)!,
              harness.workspacePath,
              verifiedEnvironmentCommand(
                [{
                  name: principal.environmentName,
                  value: principal.canary,
                }],
                absentExcept(principal.environmentName),
                marker,
                {
                  startedPath: startedPaths[index]!,
                  releasePath,
                },
              ),
            ).then(
              (execution) => ({ execution, error: null, marker, path }),
              (error: unknown) => ({ execution: null, error, marker, path }),
            );
          });

          await waitForFiles(startedPaths);
          expect(
            (await Promise.all(
              startedPaths.map(async (path) => await fileExists(path)),
            )).every(Boolean),
          ).toBe(true);
          expect(await fileExists(releasePath)).toBe(false);
          await writeFile(releasePath, "release", { flag: "wx" });

          for (const outcome of await Promise.all(pending)) {
            if (outcome.error) {
              if (outcome.error instanceof Error) throw outcome.error;
              throw new Error("Docker barrier execution failed");
            }
            if (!outcome.execution) {
              throw new Error("missing Docker barrier execution result");
            }
            repeatedExecutions.push({
              ...outcome.execution,
              marker: outcome.marker,
              path: outcome.path,
            });
          }
        }
        for (const execution of repeatedExecutions) {
          expect(execution.exitCode).toBe(0);
          assertSafeExactOutput(
            execution.output,
            needles,
            execution.marker,
            execution.path,
          );
          visibleOutputs.push({
            path: execution.path,
            bytes: execution.output,
          });
        }

        await grantEnvironmentLease(
          harness,
          WORKER_ONE,
          workerOneOnceSecret.secretId,
          WORKER_ONE_ONCE,
          "one_use",
        );
        await grantEnvironmentLease(
          harness,
          WORKER_TWO,
          workerTwoOnceSecret.secretId,
          WORKER_TWO_ONCE,
          "one_use",
        );
        const workerOneOneUseExecution = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_ONE)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [
              { name: WORKER_ONE_VALUE, value: canaries.workerOne },
              { name: WORKER_ONE_ONCE, value: canaries.workerOneOnce },
            ],
            absentExcept(WORKER_ONE_VALUE, WORKER_ONE_ONCE),
            "worker-one-consumed-own-once",
          ),
        );
        expect(workerOneOneUseExecution.exitCode).toBe(0);
        assertSafeExactOutput(
          workerOneOneUseExecution.output,
          needles,
          "worker-one-consumed-own-once",
          "worker-one-one-use",
        );
        visibleOutputs.push({
          path: "worker-one-one-use",
          bytes: workerOneOneUseExecution.output,
        });

        const workerOneAfterOneUse =
          await harness.service.getSecureSessionSnapshot(WORKER_ONE);
        const workerTwoBeforeOwnUse =
          await harness.service.getSecureSessionSnapshot(WORKER_TWO);
        expect(workerOneAfterOneUse).toEqual(expect.objectContaining({
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: workerOneSecret.secretId,
              leaseKind: "task",
              status: "active",
            }),
            expect.objectContaining({
              secretId: workerOneOnceSecret.secretId,
              leaseKind: "one_use",
              status: "consumed",
              remainingUses: 0,
            }),
          ]),
        }));
        expect(workerTwoBeforeOwnUse).toEqual(expect.objectContaining({
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: workerTwoOnceSecret.secretId,
              leaseKind: "one_use",
              status: "active",
              remainingUses: 1,
            }),
          ]),
        }));

        const reflected = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_ONE)!,
          ),
          harness.workspacePath,
          reflectedEnvironmentCommand(WORKER_ONE_VALUE),
        );
        expect(reflected.exitCode).toBe(0);
        assertSafeExactOutput(
          reflected.output,
          needles,
          SECURE_OUTPUT_QUARANTINE,
          "worker-one-reflection",
        );
        visibleOutputs.push({
          path: "worker-one-reflection",
          bytes: reflected.output,
        });
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_ONE),
        ).toEqual(expect.objectContaining({
          outputState: "quarantined",
          environmentStatus: "ready",
        }));
        expect(
          await harness.service.getSecureSessionSnapshot(MANAGER),
        ).toEqual(expect.objectContaining({ outputState: "clear" }));
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_TWO),
        ).toEqual(expect.objectContaining({ outputState: "clear" }));

        const managerContinues = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(MANAGER)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [{ name: MANAGER_VALUE, value: canaries.manager }],
            absentExcept(MANAGER_VALUE),
            "manager-continued-after-worker-quarantine",
          ),
        );
        const workerTwoContinues = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_TWO)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [
              { name: WORKER_TWO_VALUE, value: canaries.workerTwo },
              { name: WORKER_TWO_ONCE, value: canaries.workerTwoOnce },
            ],
            absentExcept(WORKER_TWO_VALUE, WORKER_TWO_ONCE),
            "worker-two-continued-after-sibling-quarantine",
          ),
        );
        for (const [path, marker, execution] of [
          [
            "manager-after-quarantine",
            "manager-continued-after-worker-quarantine",
            managerContinues,
          ],
          [
            "worker-two-after-quarantine",
            "worker-two-continued-after-sibling-quarantine",
            workerTwoContinues,
          ],
        ] as const) {
          expect(execution.exitCode).toBe(0);
          assertSafeExactOutput(execution.output, needles, marker, path);
          visibleOutputs.push({ path, bytes: execution.output });
        }
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_TWO),
        ).toEqual(expect.objectContaining({
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: workerTwoOnceSecret.secretId,
              status: "consumed",
              remainingUses: 0,
            }),
          ]),
        }));
        dockerEvidence.push(
          ...await collectScopeEvidence(
            harness.scopeHash,
            "after-worker-quarantine",
          ),
        );

        const retainedWorkerOneBinding = requireBinding(
          harness.service,
          harness.descriptors.get(WORKER_ONE)!,
        );
        const inFlightStartedPath = join(
          harness.workspacePath,
          ".old-assignment-in-flight.started",
        );
        const inFlightReleasePath = join(
          harness.workspacePath,
          ".old-assignment-in-flight.release",
        );
        const inFlightCompletedPath = join(
          harness.workspacePath,
          ".old-assignment-in-flight.completed",
        );
        const inFlightOldAssignment = executeAndCapture(
          retainedWorkerOneBinding,
          harness.workspacePath,
          fencedSentinelCommand(
            inFlightStartedPath,
            inFlightReleasePath,
            inFlightCompletedPath,
          ),
        ).then(
          (execution) => ({ execution, error: null }),
          (error: unknown) => ({ execution: null, error }),
        );
        await waitForFiles([inFlightStartedPath]);
        expect(await fileExists(inFlightStartedPath)).toBe(true);
        expect(await fileExists(inFlightReleasePath)).toBe(false);
        expect(await fileExists(inFlightCompletedPath)).toBe(false);

        setWorkerAssignment(
          harness.descriptors.get(WORKER_ONE)!,
          NEXT_ASSIGNMENT_ONE,
        );
        await harness.service.advanceWorkerSecureAssignment(
          WORKER_ONE,
          NEXT_ASSIGNMENT_ONE,
        );
        const fencedOutcome = await inFlightOldAssignment;
        expect(fencedOutcome.execution).toBeNull();
        expect(fencedOutcome.error).toMatchObject({
          code: "SECURE_OPERATION_FAILED",
        });
        expect(await fileExists(inFlightReleasePath)).toBe(false);
        expect(await fileExists(inFlightCompletedPath)).toBe(false);

        const staleBindingSentinel = join(
          harness.workspacePath,
          ".stale-binding-executed",
        );
        await expect(Promise.resolve().then(async () =>
          await retainedWorkerOneBinding.executeBash({
            command: writeSentinelCommand(staleBindingSentinel),
            cwd: harness.workspacePath,
            onData: () => undefined,
          })
        )).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
        expect(await fileExists(staleBindingSentinel)).toBe(false);

        expectIndependentTasks(
          await listScopeContainers(harness.scopeHash),
          [
            MANAGER,
            workerTaskId(WORKER_ONE, NEXT_ASSIGNMENT_ONE),
            workerTaskId(WORKER_TWO, ASSIGNMENT_TWO),
          ],
        );
        const workerOneAdvanced = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_ONE)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [{ name: WORKER_ONE_VALUE, value: canaries.workerOne }],
            absentExcept(WORKER_ONE_VALUE),
            "worker-one-new-assignment-retained-task",
          ),
        );
        expect(workerOneAdvanced.exitCode).toBe(0);
        assertSafeExactOutput(
          workerOneAdvanced.output,
          needles,
          "worker-one-new-assignment-retained-task",
          "worker-one-new-assignment",
        );
        visibleOutputs.push({
          path: "worker-one-new-assignment",
          bytes: workerOneAdvanced.output,
        });
        const workerOneAdvancedSnapshot =
          await harness.service.getSecureSessionSnapshot(WORKER_ONE);
        expect(workerOneAdvancedSnapshot).toEqual(expect.objectContaining({
          workerAssignmentId: NEXT_ASSIGNMENT_ONE,
          outputState: "clear",
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: workerOneSecret.secretId,
              leaseKind: "task",
              status: "active",
            }),
          ]),
        }));

        const workerOneTaskLease = workerOneAdvancedSnapshot.leases.find(
          ({ secretId }) => secretId === workerOneSecret.secretId,
        );
        expect(workerOneTaskLease).toBeDefined();
        if (!workerOneTaskLease) {
          throw new Error("expected retained worker task lease");
        }
        const afterWorkerOneRevoke =
          await harness.service.revokeSecureSessionLease(WORKER_ONE, {
            baseRevision: workerOneAdvancedSnapshot.revision,
            leaseId: workerOneTaskLease.leaseId,
          });
        expect(afterWorkerOneRevoke).toEqual(expect.objectContaining({
          environmentStatus: "stopped",
          leases: expect.arrayContaining([
            expect.objectContaining({
              leaseId: workerOneTaskLease.leaseId,
              status: "revoked",
            }),
          ]),
        }));
        const afterWorkerOneStop = await harness.service.stopSecureSession(
          WORKER_ONE,
          {
            baseRevision: afterWorkerOneRevoke.revision,
            stopProcesses: true,
          },
        );
        expect(afterWorkerOneStop).toEqual(expect.objectContaining({
          executionMode: "standard",
          environmentStatus: "stopped",
        }));
        expect(harness.service.getSecureRuntimeBinding(
          harness.descriptors.get(WORKER_ONE)!,
        )).toBeUndefined();
        const survivingScopeContainers = await listScopeContainers(
          harness.scopeHash,
        );
        expectIndependentTasks(
          survivingScopeContainers,
          [
            MANAGER,
            workerTaskId(WORKER_TWO, ASSIGNMENT_TWO),
          ],
        );
        expect(
          await listDirectoryOrEmpty(harness.heartbeatRoot),
        ).toEqual(survivingScopeContainers.map(({ name }) => name).sort());

        const managerAfterStop = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(MANAGER)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [{ name: MANAGER_VALUE, value: canaries.manager }],
            absentExcept(MANAGER_VALUE),
            "manager-survived-worker-stop",
          ),
        );
        const workerTwoAfterStop = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_TWO)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [{ name: WORKER_TWO_VALUE, value: canaries.workerTwo }],
            absentExcept(WORKER_TWO_VALUE),
            "worker-two-survived-sibling-stop",
          ),
        );
        for (const [path, marker, execution] of [
          [
            "manager-after-worker-stop",
            "manager-survived-worker-stop",
            managerAfterStop,
          ],
          [
            "worker-two-after-worker-stop",
            "worker-two-survived-sibling-stop",
            workerTwoAfterStop,
          ],
        ] as const) {
          expect(execution.exitCode).toBe(0);
          assertSafeExactOutput(execution.output, needles, marker, path);
          visibleOutputs.push({ path, bytes: execution.output });
        }
        expect(harness.service.isTeamSecureMode(MANAGER)).toBe(true);

        dockerEvidence.push(
          ...await collectScopeEvidence(harness.scopeHash, "final-live-team"),
        );
        const invocationEvidence = {
          path: "docker-invocations",
          bytes: Buffer.from(JSON.stringify(harness.invocations)),
        };
        const evidenceReport = scanNamedBytes(
          [
            invocationEvidence,
            ...visibleOutputs,
            ...dockerEvidence,
          ],
          needles,
        );
        const filesystemReport = await scanDirectory(
          harness.workspacePath,
          needles,
        );
        expect(evidenceReport.totalMatches).toBe(0);
        expect(evidenceReport.matches).toEqual([]);
        expect(filesystemReport.totalMatches).toBe(0);
        expect(filesystemReport.matches).toEqual([]);
        invocationEvidence.bytes.fill(0);
      } finally {
        for (const evidence of [...visibleOutputs, ...dockerEvidence]) {
          evidence.bytes.fill(0);
        }
        for (const needle of needles) needle.fill(0);
        for (const canary of allCanaries) canary.fill(0);
        await harness.closeAndAssertNoOrphans();
      }
    }, 300_000);
  },
);

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
import { acquireSecureDockerTestLock } from "../../test-support/secure-docker-test-lock.js";
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

const NOW = "2026-07-27T12:00:00.000Z";
const PROFILE = "docker-e2e-profile";
const MANAGER = "docker-e2e-manager";
const WORKER_ONE = "docker-e2e-worker-one";
const WORKER_TWO = "docker-e2e-worker-two";
const ASSIGNMENT_ONE = "docker-e2e-assignment-one";
const ASSIGNMENT_TWO = "docker-e2e-assignment-two";
const NEXT_ASSIGNMENT_ONE = "docker-e2e-assignment-one-next";
const SHARED_PRIMARY = "FORGE_DOCKER_E2E_SHARED_PRIMARY";
const SHARED_SECONDARY = "FORGE_DOCKER_E2E_SHARED_SECONDARY";
const SHARED_ONE_USE = "FORGE_DOCKER_E2E_SHARED_ONE_USE";

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
const runnerImage = `${uniqueManagedName("team-runner")}:latest`;
const emergencyCleanups = new Set<() => Promise<void>>();
let releaseDockerTestLock: (() => Promise<void>) | undefined;

interface ScopeContainer {
  name: string;
  id: string;
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
    `Forge team Docker E2E/${label}/${randomBytes(18).toString("hex")}?"\\end`,
    "utf8",
  );
}

async function buildRunnerFixtureImage(): Promise<void> {
  const runnerContext = resolve(
    repositoryRoot,
    "apps/backend/src/swarm/secure-sessions/execution",
  );
  const built = await runCommand("docker", [
    "build",
    "--tag",
    runnerImage,
    "--file",
    resolve(runnerContext, "Dockerfile.secure-runner"),
    runnerContext,
  ], {
    cwd: repositoryRoot,
    timeoutMs: 180_000,
  });
  if (built.exitCode !== 0) {
    throw new Error("failed to build production secure-session runner image");
  }
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

function reflectedEnvironmentCommand(environmentName: string): string {
  const script =
    `process.stdout.write(process.env[${JSON.stringify(environmentName)}])`;
  return `node -e ${JSON.stringify(script)}`;
}

function writeSentinelCommand(sentinelPath: string): string {
  const script =
    `require("node:fs").writeFileSync(${
      JSON.stringify(sentinelPath)
    },"ran",{flag:"wx"})`;
  return `node -e ${JSON.stringify(script)}`;
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
      [
        "{{.Id}}",
        `{{index .Config.Labels ${JSON.stringify(
          dockerSecureExecutionMetadata.taskLabel,
        )}}}`,
      ].join(" "),
      name,
    ], { timeoutMs: 30_000 });
    expect(inspected.exitCode).toBe(0);
    const [id, taskHash] = inspected.stdout.toString("utf8").trim().split(" ");
    containers.push({
      name,
      id: id ?? "",
      taskHash: taskHash ?? "",
    });
  }
  return containers.sort((left, right) => left.name.localeCompare(right.name));
}

function expectOneManagerSandbox(
  containers: readonly ScopeContainer[],
): ScopeContainer {
  expect(containers).toHaveLength(1);
  expect(containers[0]?.taskHash).toBe(sha256(MANAGER));
  return containers[0]!;
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
            "for(const name of fs.readdirSync(path).sort())walk(path+'/'+name);",
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

async function createDockerHarness() {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "forge-secure-team-e2e-"),
  );
  const workspacePath = await realpath(temporaryRoot);
  const scope = uniqueManagedName("team-scope");
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
      return { material: new HostOnlySecret(bytes) };
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
        material: (await cipher.decrypt(input.encryptedMaterial)).material,
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
    listProfiles: () => [{ profileId: PROFILE }],
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
    createId: () => `team-docker-e2e-${++nextId}`,
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
  addressedAgentId: string,
  secretId: string,
  environmentName: string,
  leaseKind: "task" | "one_use",
) {
  const before =
    await harness.service.getSecureSessionSnapshot(addressedAgentId);
  return await harness.service.grantSecureSessionLease(addressedAgentId, {
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
  `SecureSessionsService shared-team Docker integration [${
    dockerAvailable ? "available" : "backend_unavailable"
  }]`,
  () => {
    beforeAll(async () => {
      releaseDockerTestLock = await acquireSecureDockerTestLock();
      await buildRunnerFixtureImage();
    }, 300_000);

    afterAll(async () => {
      try {
        await removeManagedImage(runnerImage);
      } finally {
        await releaseDockerTestLock?.();
        releaseDockerTestLock = undefined;
      }
    }, 60_000);

    it("runs the manager team through one shared sandbox and authority lifecycle", async () => {
      const harness = await createDockerHarness();
      const canaries = {
        primary: makeCanary("primary"),
        secondary: makeCanary("secondary"),
        oneUse: makeCanary("one-use"),
      };
      const allCanaries = Object.values(canaries);
      const needles = allCanaries.flatMap((canary) => canaryNeedles(canary));
      const visibleOutputs: NamedEvidence[] = [];
      const dockerEvidence: NamedEvidence[] = [];

      try {
        const primary = await createEnvironmentSecret(
          harness,
          "primary",
          SHARED_PRIMARY,
          canaries.primary,
        );
        const secondary = await createEnvironmentSecret(
          harness,
          "secondary",
          SHARED_SECONDARY,
          canaries.secondary,
        );
        const oneUse = await createEnvironmentSecret(
          harness,
          "one-use",
          SHARED_ONE_USE,
          canaries.oneUse,
        );

        await harness.service.startSecureSession(MANAGER);
        const retainedBindings = new Map(
          [MANAGER, WORKER_ONE, WORKER_TWO].map((agentId) => [
            agentId,
            requireBinding(
              harness.service,
              harness.descriptors.get(agentId)!,
            ),
          ]),
        );
        await grantEnvironmentLease(
          harness,
          MANAGER,
          primary.secretId,
          SHARED_PRIMARY,
          "task",
        );
        await grantEnvironmentLease(
          harness,
          WORKER_ONE,
          secondary.secretId,
          SHARED_SECONDARY,
          "task",
        );

        const managerSnapshot =
          await harness.service.getSecureSessionSnapshot(MANAGER);
        expect(managerSnapshot).toEqual(expect.objectContaining({
          sessionAgentId: MANAGER,
          principalKind: "manager",
          ownerManagerAgentId: null,
          workerAssignmentId: null,
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: primary.secretId,
              status: "active",
            }),
            expect.objectContaining({
              secretId: secondary.secretId,
              status: "active",
            }),
          ]),
        }));
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_ONE),
        ).toEqual(managerSnapshot);
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_TWO),
        ).toEqual(managerSnapshot);
        for (const binding of retainedBindings.values()) {
          expect(binding.guardValue(canaries.primary)).toBe(
            SECURE_OUTPUT_QUARANTINE,
          );
          expect(binding.guardValue(canaries.secondary)).toBe(
            SECURE_OUTPUT_QUARANTINE,
          );
        }

        const initialSandbox = expectOneManagerSandbox(
          await listScopeContainers(harness.scopeHash),
        );
        expect(
          await listDirectoryOrEmpty(harness.heartbeatRoot),
        ).toEqual([initialSandbox.name]);

        const commonExpected = [
          { name: SHARED_PRIMARY, value: canaries.primary },
          { name: SHARED_SECONDARY, value: canaries.secondary },
        ];
        for (const [agentId, marker] of [
          [MANAGER, "manager-sees-shared-leases"],
          [WORKER_ONE, "worker-one-sees-shared-leases"],
          [WORKER_TWO, "worker-two-sees-shared-leases"],
        ] as const) {
          const execution = await executeAndCapture(
            retainedBindings.get(agentId)!,
            harness.workspacePath,
            verifiedEnvironmentCommand(
              commonExpected,
              [SHARED_ONE_USE],
              marker,
            ),
          );
          expect(execution.exitCode).toBe(0);
          assertSafeExactOutput(execution.output, needles, marker, marker);
          visibleOutputs.push({ path: marker, bytes: execution.output });
        }

        const concurrentRelease = join(
          harness.workspacePath,
          ".team-concurrent.release",
        );
        const concurrentParticipants = [MANAGER, WORKER_ONE, WORKER_TWO] as const;
        const concurrentStarted = concurrentParticipants.map((agentId) =>
          join(harness.workspacePath, `.team-concurrent-${agentId}.started`)
        );
        const concurrent = concurrentParticipants.map((agentId, index) => {
          const marker = `concurrent-${agentId}`;
          return executeAndCapture(
            retainedBindings.get(agentId)!,
            harness.workspacePath,
            verifiedEnvironmentCommand(
              commonExpected,
              [SHARED_ONE_USE],
              marker,
              {
                startedPath: concurrentStarted[index]!,
                releasePath: concurrentRelease,
              },
            ),
          ).then((execution) => ({ execution, marker }));
        });
        await waitForFiles(concurrentStarted);
        expectOneManagerSandbox(await listScopeContainers(harness.scopeHash));
        await writeFile(concurrentRelease, "release", { flag: "wx" });
        for (const { execution, marker } of await Promise.all(concurrent)) {
          expect(execution.exitCode).toBe(0);
          assertSafeExactOutput(execution.output, needles, marker, marker);
          visibleOutputs.push({ path: marker, bytes: execution.output });
        }

        await grantEnvironmentLease(
          harness,
          WORKER_TWO,
          oneUse.secretId,
          SHARED_ONE_USE,
          "one_use",
        );
        const oneUseRelease = join(
          harness.workspacePath,
          ".team-one-use.release",
        );
        const oneUseStarted = join(
          harness.workspacePath,
          ".team-one-use.started",
        );
        const consuming = executeAndCapture(
          retainedBindings.get(WORKER_ONE)!,
          harness.workspacePath,
          verifiedEnvironmentCommand(
            [
              ...commonExpected,
              { name: SHARED_ONE_USE, value: canaries.oneUse },
            ],
            [],
            "worker-one-reserved-one-use",
            {
              startedPath: oneUseStarted,
              releasePath: oneUseRelease,
            },
          ),
        );
        await waitForFiles([oneUseStarted]);
        const siblingWhileReserved = await executeAndCapture(
          retainedBindings.get(WORKER_TWO)!,
          harness.workspacePath,
          verifiedEnvironmentCommand(
            commonExpected,
            [SHARED_ONE_USE],
            "worker-two-cannot-double-reserve",
          ),
        );
        assertSafeExactOutput(
          siblingWhileReserved.output,
          needles,
          "worker-two-cannot-double-reserve",
          "one-use-sibling",
        );
        visibleOutputs.push({
          path: "one-use-sibling",
          bytes: siblingWhileReserved.output,
        });
        await writeFile(oneUseRelease, "release", { flag: "wx" });
        const consumed = await consuming;
        assertSafeExactOutput(
          consumed.output,
          needles,
          "worker-one-reserved-one-use",
          "one-use-consumer",
        );
        visibleOutputs.push({
          path: "one-use-consumer",
          bytes: consumed.output,
        });
        const afterConsumption =
          await harness.service.getSecureSessionSnapshot(MANAGER);
        expect(afterConsumption).toEqual(expect.objectContaining({
          environmentStatus: "ready",
          leases: expect.arrayContaining([
            expect.objectContaining({
              secretId: oneUse.secretId,
              leaseKind: "one_use",
              status: "consumed",
              remainingUses: 0,
            }),
          ]),
        }));
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_TWO),
        ).toEqual(afterConsumption);
        expectOneManagerSandbox(await listScopeContainers(harness.scopeHash));

        const reflected = await executeAndCapture(
          retainedBindings.get(WORKER_ONE)!,
          harness.workspacePath,
          reflectedEnvironmentCommand(SHARED_PRIMARY),
        );
        expect(reflected.exitCode).toBe(0);
        assertSafeExactOutput(
          reflected.output,
          needles,
          SECURE_OUTPUT_QUARANTINE,
          "worker-reflection",
        );
        visibleOutputs.push({
          path: "worker-reflection",
          bytes: reflected.output,
        });
        const quarantined =
          await harness.service.getSecureSessionSnapshot(MANAGER);
        expect(quarantined.outputState).toBe("quarantined");
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_ONE),
        ).toEqual(quarantined);
        expect(
          await harness.service.getSecureSessionSnapshot(WORKER_TWO),
        ).toEqual(quarantined);

        const staleBinding = requireBinding(
          harness.service,
          harness.descriptors.get(WORKER_ONE)!,
        );
        const sandboxBeforeAssignment = expectOneManagerSandbox(
          await listScopeContainers(harness.scopeHash),
        );
        setWorkerAssignment(
          harness.descriptors.get(WORKER_ONE)!,
          NEXT_ASSIGNMENT_ONE,
        );
        await harness.service.advanceWorkerSecureAssignment(
          WORKER_ONE,
          NEXT_ASSIGNMENT_ONE,
        );
        const sandboxAfterAssignment = expectOneManagerSandbox(
          await listScopeContainers(harness.scopeHash),
        );
        expect(sandboxAfterAssignment.id).toBe(sandboxBeforeAssignment.id);

        const staleSentinel = join(
          harness.workspacePath,
          ".stale-assignment-ran",
        );
        await expect(Promise.resolve().then(async () =>
          await staleBinding.executeBash({
            command: writeSentinelCommand(staleSentinel),
            cwd: harness.workspacePath,
            onData: () => undefined,
          })
        )).rejects.toMatchObject({ code: "SECURE_OPERATION_FAILED" });
        expect(await fileExists(staleSentinel)).toBe(false);

        const replacement = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_ONE)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            commonExpected,
            [SHARED_ONE_USE],
            "replacement-assignment-shared-authority",
          ),
        );
        assertSafeExactOutput(
          replacement.output,
          needles,
          "replacement-assignment-shared-authority",
          "replacement-assignment",
        );
        visibleOutputs.push({
          path: "replacement-assignment",
          bytes: replacement.output,
        });

        const removedWorkerBinding = requireBinding(
          harness.service,
          harness.descriptors.get(WORKER_ONE)!,
        );
        harness.descriptors.delete(WORKER_ONE);
        expect(() => removedWorkerBinding.guardValue("safe")).toThrow(
          "SECURE_OPERATION_FAILED",
        );
        const sandboxAfterWorkerTeardown = expectOneManagerSandbox(
          await listScopeContainers(harness.scopeHash),
        );
        expect(sandboxAfterWorkerTeardown.id).toBe(sandboxBeforeAssignment.id);
        const siblingAfterTeardown = await executeAndCapture(
          requireBinding(
            harness.service,
            harness.descriptors.get(WORKER_TWO)!,
          ),
          harness.workspacePath,
          verifiedEnvironmentCommand(
            commonExpected,
            [SHARED_ONE_USE],
            "worker-teardown-kept-team-authority",
          ),
        );
        assertSafeExactOutput(
          siblingAfterTeardown.output,
          needles,
          "worker-teardown-kept-team-authority",
          "worker-teardown",
        );
        visibleOutputs.push({
          path: "worker-teardown",
          bytes: siblingAfterTeardown.output,
        });

        dockerEvidence.push(
          ...await collectScopeEvidence(harness.scopeHash, "live-team"),
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

        const beforeStop =
          await harness.service.getSecureSessionSnapshot(WORKER_TWO);
        const stopped = await harness.service.stopSecureSession(WORKER_TWO, {
          baseRevision: beforeStop.revision,
          stopProcesses: true,
        });
        expect(stopped).toEqual(expect.objectContaining({
          sessionAgentId: MANAGER,
          executionMode: "standard",
          environmentStatus: "stopped",
        }));
        expect(await listScopeContainers(harness.scopeHash)).toEqual([]);
        expect(await listDirectoryOrEmpty(harness.heartbeatRoot)).toEqual([]);
        expect(harness.service.getSecureRuntimeBinding(
          harness.descriptors.get(MANAGER)!,
        )).toBeUndefined();
        expect(harness.service.getSecureRuntimeBinding(
          harness.descriptors.get(WORKER_TWO)!,
        )).toBeUndefined();
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

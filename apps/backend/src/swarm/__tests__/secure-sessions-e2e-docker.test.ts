import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  collectDockerEvidence,
  buildFixtureImages,
  dockerContainerExists,
  removeManagedContainer,
  removeManagedImage,
  runCommand,
  startFixtureDatabase,
  startFixtureTarget,
  uniqueManagedName,
} from "../../../../../scripts/secure-sessions-e2e/harness.js";
import {
  canaryNeedles,
  scanDirectory,
  scanNamedBytes,
} from "../../../../../scripts/secure-sessions-e2e/privacy-safe-scan.js";
import {
  DockerSecureExecutionBackend,
} from "../secure-sessions/execution/docker-secure-execution-backend.js";
import type {
  SecureExecutionDelivery,
  SecureExecutionRequest,
  SecureExecutionResult,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";
import {
  SECURE_OUTPUT_QUARANTINE,
  SecureValueGuard,
} from "../secure-sessions/redaction/secure-value-guard.js";

const repositoryRoot = await realpath(resolve(process.cwd(), "../.."));
const daemonProbe = process.platform === "win32"
  ? { exitCode: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  : await runCommand("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
const dockerAvailable =
  daemonProbe.exitCode === 0 && daemonProbe.stdout.byteLength > 0;
const dockerSuite = dockerAvailable
  ? describe.sequential
  : describe.skip;
const runnerImage = `${uniqueManagedName("runner")}:latest`;
const targetImage = `${uniqueManagedName("target")}:latest`;
const cleanups: Array<() => Promise<unknown>> = [];

function makeCanary(): Buffer {
  return Buffer.from(
    `Forge E2E/${randomBytes(17).toString("hex")}?"\\end`,
    "utf8",
  );
}

function makeTask(workspacePath: string, label: string): SecureExecutionTask {
  return {
    taskId: `${label}-${randomBytes(8).toString("hex")}`,
    workspacePath,
  };
}

async function inspectContainerId(name: string): Promise<string> {
  const inspected = await runCommand("docker", [
    "container",
    "inspect",
    "--format",
    "{{.Id}}",
    name,
  ]);
  expect(inspected.exitCode).toBe(0);
  return inspected.stdout.toString("utf8").trim();
}

async function executeGuarded(
  backend: DockerSecureExecutionBackend,
  request: Omit<SecureExecutionRequest, "guardOutput" | "onOutput">,
  canary: Buffer,
  evidenceLabel: string,
): Promise<SecureExecutionResult> {
  const guard = new SecureValueGuard([canary]);
  const published: Array<{ path: string; bytes: Buffer }> = [];
  const needles = canaryNeedles(canary);
  try {
    const result = await backend.execute({
      ...request,
      guardOutput: guard.createOutputGuard(),
      onOutput: ({ stream, bytes }) => {
        published.push({
          path: `${evidenceLabel}-${stream}-${published.length}`,
          bytes: Buffer.from(bytes),
        });
      },
    });
    const report = scanNamedBytes(
      [
        { path: `${evidenceLabel}-stdout`, bytes: result.stdout },
        { path: `${evidenceLabel}-stderr`, bytes: result.stderr },
        ...published,
      ],
      needles,
    );
    expect(report).toEqual({
      scannedFileCount: 2 + published.length,
      totalMatches: 0,
      matches: [],
    });
    return result;
  } finally {
    guard.dispose();
    for (const needle of needles) {
      needle.fill(0);
    }
    for (const output of published) {
      output.bytes.fill(0);
    }
  }
}

function reflectedCommand(
  transform:
    | "raw"
    | "base64"
    | "base64-unpadded"
    | "base64url"
    | "hex"
    | "url"
    | "json",
  stream: "stdout" | "stderr" = "stdout",
): { executable: string; args: string[] } {
  const expressionByTransform = {
    raw: "value",
    base64: "Buffer.from(value).toString('base64')",
    "base64-unpadded":
      "Buffer.from(value).toString('base64').replace(/=+$/u,'')",
    base64url: "Buffer.from(value).toString('base64url')",
    hex: "Buffer.from(value).toString('hex')",
    url: "encodeURIComponent(value)",
    json: "JSON.stringify(value).slice(1,-1)",
  } as const;
  return {
    executable: "node",
    args: [
      "-e",
      `const value=process.env.FORGE_E2E_CANARY;process.${stream}.write(${expressionByTransform[transform]})`,
    ],
  };
}

function environmentDelivery(canary: Buffer): SecureExecutionDelivery {
  return {
    environment: [{ name: "FORGE_E2E_CANARY", value: canary }],
  };
}

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  await Promise.allSettled(pending.map(async (cleanup) => await cleanup()));
});

dockerSuite(
  `secure sessions exhaustive Docker harness [${dockerAvailable ? "available" : "backend_unavailable"}]`,
  () => {
    beforeAll(async () => {
      await buildFixtureImages(
        repositoryRoot,
        runnerImage,
        targetImage,
      );
    }, 240_000);

    afterAll(async () => {
      await removeManagedImage(targetImage);
      await removeManagedImage(runnerImage);
    }, 60_000);

    it("contains all delivery channels and encoded reflections across eighteen persistent commands", async () => {
      const canary = makeCanary();
      const needles = canaryNeedles(canary);
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "forge-secure-e2e-workspace-"),
      );
      const workspacePath = await realpath(temporaryRoot);
      const targetName = uniqueManagedName("target-container");
      const target = await startFixtureTarget(
        targetImage,
        targetName,
        canary,
      );
      cleanups.push(async () => await removeManagedContainer(targetName));
      const databaseName = uniqueManagedName("database-container");
      const database = await startFixtureDatabase(databaseName, canary);
      cleanups.push(async () => await removeManagedContainer(databaseName));
      const invocations: string[][] = [];
      const backend = new DockerSecureExecutionBackend({
        image: runnerImage,
        scope: uniqueManagedName("persistent-scope"),
        onDockerInvocation: ({ args }) => invocations.push([...args]),
      });
      const task = makeTask(workspacePath, "persistent");
      cleanups.push(
        async () => {
          canary.fill(0);
          for (const needle of needles) {
            needle.fill(0);
          }
        },
        async () => await rm(temporaryRoot, { recursive: true, force: true }),
        async () => await backend.destroyTask(task),
      );

      const sandbox = await backend.ensureTask(task);
      const originalContainerId = await inspectContainerId(sandbox.sandboxId);
      const executions: Array<{
        command: { executable: string; args: string[] };
        delivery?: SecureExecutionDelivery;
        expectQuarantine?: boolean;
        expectedOutput?: string;
      }> = [
        {
          command: reflectedCommand("raw"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("raw", "stderr"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: {
            executable: "node",
            args: ["-e", "process.stdin.pipe(process.stdout)"],
          },
          delivery: { stdin: canary },
          expectQuarantine: true,
        },
        {
          command: {
            executable: "node",
            args: [
              "-e",
              "process.stdout.write(require('node:fs').readFileSync(process.env.FORGE_E2E_FILE))",
            ],
          },
          delivery: {
            ramFiles: [
              {
                targetPath: "/run/forge-secure/bindings/nested/canary",
                value: canary,
                pathEnvironmentVariable: "FORGE_E2E_FILE",
              },
            ],
          },
          expectQuarantine: true,
        },
        {
          command: {
            executable: "node",
            args: [
              "-e",
              "const v=process.env.FORGE_E2E_CANARY;process.stdout.write(v.slice(0,7));setTimeout(()=>process.stdout.write(v.slice(7)),40)",
            ],
          },
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: {
            executable: "node",
            args: [
              "-e",
              "const v=process.env.FORGE_E2E_CANARY;process.stderr.write(v.slice(0,11));setTimeout(()=>process.stderr.write(v.slice(11)),40)",
            ],
          },
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("base64"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("base64-unpadded"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("base64url"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("hex"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("url"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: reflectedCommand("json"),
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: {
            executable: "node",
            args: [
              "-e",
              `const http=require('node:http');const request=http.request({host:${JSON.stringify(target.ipAddress)},port:8080,method:'POST'},response=>response.pipe(process.stdout));request.once('error',()=>process.exit(2));request.end(process.env.FORGE_E2E_CANARY)`,
            ],
          },
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: {
            executable: "ssh",
            args: [
              "-o",
              "BatchMode=no",
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "LogLevel=ERROR",
              "-o",
              "ConnectTimeout=5",
              `forge@${target.ipAddress}`,
              "printf ssh-ok",
            ],
          },
          delivery: {
            askpass: [{ targetName: "SSH_ASKPASS", value: canary }],
          },
          expectedOutput: "ssh-ok",
        },
        {
          command: {
            executable: "sh",
            args: [
              "-c",
              "getent passwd \"$(id -u)\" >/dev/null && getent group \"$(id -g)\" >/dev/null && ssh -G forge-secure.invalid >/dev/null && printf identity-ok",
            ],
          },
          expectedOutput: "identity-ok",
        },
        {
          command: {
            executable: "node",
            args: [
              "-e",
              "const v=process.env.FORGE_E2E_CANARY;const n=Math.floor(v.length/2);process.stdout.write(v.slice(0,n));setTimeout(()=>process.stderr.write(v.slice(n)),40)",
            ],
          },
          delivery: environmentDelivery(canary),
          expectQuarantine: true,
        },
        {
          command: {
            executable: "psql",
            args: [
              "--host",
              database.ipAddress,
              "--username",
              "postgres",
              "--dbname",
              "postgres",
              "--no-align",
              "--tuples-only",
              "--command",
              "select 'database-ok'",
            ],
          },
          delivery: {
            environment: [{ name: "PGPASSWORD", value: canary }],
          },
          expectedOutput: "database-ok\n",
        },
        {
          command: {
            executable: "script",
            args: [
              "-qec",
              "test -t 0 && test -t 1 && printf pty-ok",
              "/dev/null",
            ],
          },
          expectedOutput: "pty-ok",
        },
      ];

      expect(executions).toHaveLength(18);
      for (const [index, execution] of executions.entries()) {
        const result = await executeGuarded(
          backend,
          {
            task,
            command: execution.command,
            delivery: execution.delivery,
          },
          canary,
          `execution-${index + 1}`,
        );
        expect(
          result.exitCode,
          `persistent execution ${index + 1} failed: ${Buffer.from(result.stderr).toString("utf8")}`,
        ).toBe(0);
        expect(await inspectContainerId(sandbox.sandboxId)).toBe(
          originalContainerId,
        );
        const visibleOutput = Buffer.concat([
          Buffer.from(result.stdout),
          Buffer.from(result.stderr),
        ]).toString("utf8");
        if (execution.expectQuarantine) {
          expect(visibleOutput).toContain(SECURE_OUTPUT_QUARANTINE);
        }
        if (execution.expectedOutput) {
          expect(Buffer.from(result.stdout).toString("utf8")).toBe(
            execution.expectedOutput,
          );
        }
      }

      const evidenceDirectory = resolve(temporaryRoot, "evidence");
      const dockerEvidence = await collectDockerEvidence({
        sandboxName: sandbox.sandboxId,
        runnerImage,
        targetName,
        targetImage,
        outputDirectory: evidenceDirectory,
      });
      expect(await backend.destroyTask(task)).toBe(true);
      const invocationSnapshot = invocations.map((args, index) => ({
        path: `docker-invocation-${index}`,
        bytes: Buffer.from(JSON.stringify(args)),
      }));
      const invocationReport = scanNamedBytes(
        invocationSnapshot,
        needles,
      );
      const dockerReport = scanNamedBytes(dockerEvidence, needles);
      const databaseEvidence = await Promise.all(
        ([
          ["database-inspect.json", ["container", "inspect", databaseName]],
          ["database-logs.txt", ["logs", databaseName]],
        ] as const).map(async ([path, args]) => {
          const result = await runCommand("docker", args, {
            timeoutMs: 30_000,
          });
          expect(result.exitCode).toBe(0);
          return {
            path,
            bytes: Buffer.concat([result.stdout, result.stderr]),
          };
        }),
      );
      const databaseReport = scanNamedBytes(databaseEvidence, needles);
      const filesystemReport = await scanDirectory(temporaryRoot, needles);

      expect(invocationReport).toEqual({
        scannedFileCount: invocationSnapshot.length,
        totalMatches: 0,
        matches: [],
      });
      expect(dockerReport.totalMatches).toBe(0);
      expect(dockerReport.matches).toEqual([]);
      expect(databaseReport.totalMatches).toBe(0);
      expect(databaseReport.matches).toEqual([]);
      expect(filesystemReport.totalMatches).toBe(0);
      expect(filesystemReport.matches).toEqual([]);
    }, 180_000);

    it("destroys secret-bearing sandboxes on cancel, timeout, and background revocation", async () => {
      const canary = makeCanary();
      const needles = canaryNeedles(canary);
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "forge-secure-e2e-lifecycle-"),
      );
      const workspacePath = await realpath(temporaryRoot);
      const invocations: string[][] = [];
      const backend = new DockerSecureExecutionBackend({
        image: runnerImage,
        scope: uniqueManagedName("lifecycle-scope"),
        onDockerInvocation: ({ args }) => invocations.push([...args]),
      });
      const task = makeTask(workspacePath, "lifecycle");
      cleanups.push(
        async () => {
          canary.fill(0);
          for (const needle of needles) {
            needle.fill(0);
          }
        },
        async () => await rm(temporaryRoot, { recursive: true, force: true }),
        async () => await backend.destroyTask(task),
      );

      const first = await backend.ensureTask(task);
      const abortController = new AbortController();
      const abortGuard = new SecureValueGuard([canary]);
      const aborted = backend.execute({
        task,
        command: { executable: "sleep", args: ["30"] },
        delivery: environmentDelivery(canary),
        guardOutput: abortGuard.createOutputGuard(),
        signal: abortController.signal,
      });
      setTimeout(() => abortController.abort(), 150);
      await expect(aborted).rejects.toMatchObject({
        code: "EXECUTION_ABORTED",
      } satisfies Partial<SecureExecutionError>);
      abortGuard.dispose();
      expect(await dockerContainerExists(first.sandboxId)).toBe(false);

      const second = await backend.ensureTask(task);
      const timeoutGuard = new SecureValueGuard([canary]);
      await expect(
        backend.execute({
          task,
          command: { executable: "sleep", args: ["30"] },
          delivery: environmentDelivery(canary),
          guardOutput: timeoutGuard.createOutputGuard(),
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({
        code: "EXECUTION_TIMEOUT",
      } satisfies Partial<SecureExecutionError>);
      timeoutGuard.dispose();
      expect(await dockerContainerExists(second.sandboxId)).toBe(false);

      const third = await backend.ensureTask(task);
      const background = await executeGuarded(
        backend,
        {
          task,
          command: {
            executable: "node",
            args: [
              "-e",
              "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},30000)'],{detached:true,stdio:'ignore',env:process.env});child.unref();process.stdout.write('background-started')",
            ],
          },
          delivery: environmentDelivery(canary),
        },
        canary,
        "background",
      );
      expect(Buffer.from(background.stdout).toString("utf8")).toBe(
        "background-started",
      );
      expect(await backend.destroyTask(task)).toBe(true);
      expect(await dockerContainerExists(third.sandboxId)).toBe(false);
      await expect(
        backend.execute({
          task,
          command: { executable: "true", args: [] },
          guardOutput: ({ bytes }) => Buffer.from(bytes),
        }),
      ).rejects.toMatchObject({
        code: "TASK_REVOKED",
      } satisfies Partial<SecureExecutionError>);

      const listed = await runCommand("docker", [
        "ps",
        "--all",
        "--filter",
        `name=${third.sandboxId}`,
        "--format",
        "{{.Names}}",
      ]);
      const report = scanNamedBytes(
        [
          {
            path: "docker-invocations",
            bytes: Buffer.from(JSON.stringify(invocations)),
          },
          { path: "docker-ps", bytes: listed.stdout },
          { path: "docker-ps-errors", bytes: listed.stderr },
        ],
        needles,
      );
      const filesystemReport = await scanDirectory(temporaryRoot, needles);
      expect(listed.stdout.toString("utf8").trim()).toBe("");
      expect(report.totalMatches).toBe(0);
      expect(report.matches).toEqual([]);
      expect(filesystemReport.totalMatches).toBe(0);
      expect(filesystemReport.matches).toEqual([]);
    }, 90_000);
  },
);

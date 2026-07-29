import { Buffer } from "node:buffer";
import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerSecureExecutionBackend,
  dockerSecureExecutionMetadata,
} from "../secure-sessions/execution/docker-secure-execution-backend.js";
import { DockerCli } from "../secure-sessions/execution/docker-cli.js";
import type {
  SecureExecutionTask,
  SecureOutputGuard,
  SecureOutputStream,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER } from "../secure-sessions/execution/secure-execution-backend.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";

const execFileAsync = promisify(execFile);
const { stdout: gitTopLevel } = await execFileAsync(
  "git",
  ["rev-parse", "--show-toplevel"],
  { cwd: process.cwd() },
);
const workspacePath = await realpath(gitTopLevel.trim());
const probeBackend = new DockerSecureExecutionBackend({
  scope: "forge-secure-execution-probe",
});
const dockerAvailability = await probeBackend.probe();
const dockerSuite = dockerAvailability.available ? describe.sequential : describe.skip;
const cleanupOperations: Array<() => Promise<unknown>> = [];

function uniqueScope(label: string): string {
  return `${label}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function task(label: string): SecureExecutionTask {
  return {
    taskId: `${label}-${randomBytes(8).toString("hex")}`,
    workspacePath,
  };
}

function passThroughGuard(): SecureOutputGuard {
  return ({ bytes }) => Buffer.from(bytes);
}

function bufferingRedactionGuard(
  values: readonly Buffer[],
): SecureOutputGuard {
  const buffered: Record<SecureOutputStream, Buffer[]> = {
    stdout: [],
    stderr: [],
  };

  return ({ stream, bytes, final }) => {
    if (!final) {
      buffered[stream].push(Buffer.from(bytes));
      return Buffer.alloc(0);
    }

    let safe = Buffer.concat(buffered[stream]).toString("utf8");
    for (const value of values) {
      safe = safe.replaceAll(value.toString("utf8"), "[REDACTED]");
    }
    for (const retained of buffered[stream]) {
      retained.fill(0);
    }
    buffered[stream].length = 0;
    return Buffer.from(safe);
  };
}

async function dockerInspect(name: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("docker", [
    "container",
    "inspect",
    name,
  ]);
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("unexpected Docker inspect response");
  }
  return parsed[0] as Record<string, unknown>;
}

async function dockerContainerExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["container", "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

async function waitForContainerRunningState(
  name: string,
  expected: boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = await dockerInspect(name);
    const state = inspected.State as Record<string, unknown> | undefined;
    if (state?.Running === expected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Docker running state ${String(expected)}`);
}

async function startCrashOwnedSandbox(
  scope: string,
  secureTask: SecureExecutionTask,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  sandboxId: string;
}> {
  const source = [
    'import { DockerSecureExecutionBackend } from "./src/swarm/secure-sessions/execution/docker-secure-execution-backend.ts";',
    `const backend = new DockerSecureExecutionBackend({scope:${JSON.stringify(scope)}});`,
    `const sandbox = await backend.ensureTask(${JSON.stringify(secureTask)});`,
    'process.stdout.write(sandbox.sandboxId + "\\n");',
    "setInterval(() => {}, 1000);",
  ].join("");
  const child = spawnChild(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    source,
  ], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "pipe",
  });
  const sandboxId = await new Promise<string>((resolveSandbox, rejectSandbox) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectSandbox(new Error("timed out starting crash-owned sandbox"));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolveSandbox(stdout.slice(0, newline).trim());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectSandbox(error);
    });
    child.once("close", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        rejectSandbox(new Error(
          `crash-owned sandbox exited early (${String(code)}): ${stderr}`,
        ));
      }
    });
  });
  return { child, sandboxId };
}

async function hostGitCommonDirectory(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: workspacePath },
    );
    const reported = stdout.trim();
    const commonDirectory = await realpath(
      isAbsolute(reported) ? reported : resolve(workspacePath, reported),
    );
    return commonDirectory.startsWith(`${workspacePath}/`)
      ? null
      : commonDirectory;
  } catch {
    return null;
  }
}

afterEach(async () => {
  const pending = cleanupOperations.splice(0);
  await Promise.allSettled(pending.map(async (cleanup) => await cleanup()));
});

describe("Docker secure runner installation", () => {
  it("serializes installs, builds from only Forge-owned resources, and verifies the contract", async () => {
    const resources = await mkdtemp(
      join(tmpdir(), "forge-secure-runner-resources-"),
    );
    cleanupOperations.push(async () =>
      await rm(resources, { recursive: true, force: true }),
    );
    await writeFile(
      join(resources, "Dockerfile.secure-runner"),
      'FROM scratch\r\nLABEL com.forge.secure-execution.runner-contract="6"\r\n',
    );
    await writeFile(join(resources, "forge-env-askpass"), "#!/bin/sh\r\n");
    await writeFile(join(resources, "not-in-build-context"), "canary");

    let releaseBuild!: () => void;
    const buildReleased = new Promise<void>((resolveBuild) => {
      releaseBuild = resolveBuild;
    });
    let reportBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolveBuild) => {
      reportBuildStarted = resolveBuild;
    });
    let buildContextFiles: string[] = [];
    let buildContextDockerfile = "";
    let buildContextAskpass = "";
    const invocations: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    const pin = vi.spyOn(DockerCli.prototype, "pinLocalEndpoint")
      .mockResolvedValue(true);
    const run = vi.spyOn(DockerCli.prototype, "run")
      .mockImplementation(async (args, _maxStdoutBytes, timeoutMs) => {
        invocations.push([...args]);
        timeouts.push(timeoutMs);
        if (args[0] === "version") {
          return { exitCode: 0, stdout: Buffer.from('"linux"\n') };
        }
        if (args[0] === "build") {
          const context = args.at(-1);
          if (context === undefined) throw new Error("missing build context");
          buildContextFiles = (await readdir(context)).sort();
          buildContextDockerfile = await readFile(
            join(context, "Dockerfile.secure-runner"),
            "utf8",
          );
          buildContextAskpass = await readFile(
            join(context, "forge-env-askpass"),
            "utf8",
          );
          reportBuildStarted();
          await buildReleased;
          return { exitCode: 0, stdout: Buffer.from("sha256:test") };
        }
        return { exitCode: 0, stdout: Buffer.from("6\n") };
      });

    try {
      const backend = new DockerSecureExecutionBackend({
        runnerResourceDirectory: resources,
        dockerRunnerInstallTimeoutMs: 123_456,
      });
      const first = backend.installRunner();
      await buildStarted;
      const second = backend.installRunner();
      releaseBuild();

      await expect(Promise.all([first, second])).resolves.toEqual([
        { available: true, code: "available" },
        { available: true, code: "available" },
      ]);
      expect(pin).toHaveBeenCalled();
      expect(invocations.filter(([command]) => command === "build")).toHaveLength(1);
      expect(buildContextFiles).toEqual([
        "Dockerfile.secure-runner",
        "forge-env-askpass",
      ]);
      expect(buildContextDockerfile).toBe(
        'FROM scratch\nLABEL com.forge.secure-execution.runner-contract="6"\n',
      );
      expect(buildContextAskpass).toBe("#!/bin/sh\n");
      const buildIndex = invocations.findIndex(([command]) => command === "build");
      expect(timeouts[buildIndex]).toBe(123_456);
      expect(invocations[buildIndex]).toEqual([
        "build",
        "--quiet",
        "--tag",
        "forge-secure-runner:node22-v6",
        "--file",
        expect.stringMatching(/Dockerfile\.secure-runner$/),
        expect.stringMatching(/forge-secure-runner-build-/),
      ]);
      expect(invocations.at(-1)).toEqual([
        "image",
        "inspect",
        "forge-secure-runner:node22-v6",
        "--format",
        '{{index .Config.Labels "com.forge.secure-execution.runner-contract"}}',
      ]);
    } finally {
      run.mockRestore();
      pin.mockRestore();
    }
  });
});

dockerSuite(
  `Docker secure execution conformance [${dockerAvailability.code}]`,
  () => {
    it("resolves an arbitrary mapped UID and GID for common tools", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("mapped-identity"),
        runAsUser: { uid: 42_420, gid: 42_421 },
      });
      const secureTask = task("mapped-identity");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));

      const result = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            "ssh -G forge-secure.invalid >/dev/null && printf '%s:%s:%s:%s' \"$(id -u)\" \"$(id -g)\" \"$(id -un)\" \"$(id -gn)\"",
          ],
        },
        guardOutput: passThroughGuard(),
      });

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toBe(
        "42420:42421:forge-secure:forge-secure",
      );
    }, 30_000);

    it("applies execution-local SSH trust to ordinary login-shell ssh commands", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("ssh-trust"),
      });
      const secureTask = task("ssh-trust");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const resetWrapperRoot = await backend.execute({
        task: secureTask,
        command: {
          executable: "rm",
          args: ["-rf", "/tmp/forge-secure-ssh"],
        },
        guardOutput: passThroughGuard(),
      });
      expect(resetWrapperRoot.exitCode).toBe(0);

      const aliases = [
        {
          alias: "forge-trusted-one",
          hostName: "192.0.2.41",
          user: "first-user",
          port: 2201,
        },
        {
          alias: "forge-trusted-two",
          hostName: "192.0.2.42",
          user: "second-user",
          port: 2202,
        },
      ];
      const results = await Promise.all(
        aliases.map(async ({ alias, hostName, user, port }) =>
          await backend.execute({
            task: secureTask,
            command: {
              executable: "bash",
              args: [
                "-lc",
                `sleep 0.1; ssh -G ${alias} | awk '$1 == "hostname" || $1 == "user" || $1 == "port" || $1 == "stricthostkeychecking" || $1 == "userknownhostsfile" { print $1 "=" $2 }'`,
              ],
            },
            delivery: {
              sshTrust: {
                config: Buffer.from(
                  [
                    `Host ${alias}`,
                    `  HostName ${hostName}`,
                    `  User ${user}`,
                    `  Port ${port}`,
                    "  HostKeyAlias " + alias,
                    "  StrictHostKeyChecking yes",
                    `  UserKnownHostsFile ${SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER}`,
                    "",
                  ].join("\n"),
                ),
                knownHosts: Buffer.from(
                  `${alias} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKuYwA+0fN6HcYk4v0zKGhm10I/C4gXLm9yJQ4IT\n`,
                ),
              },
            },
            guardOutput: passThroughGuard(),
          }),
        ),
      );

      for (const [index, result] of results.entries()) {
        const expected = aliases[index];
        const output = Buffer.from(result.stdout).toString("utf8");
        expect(result.exitCode).toBe(0);
        expect(output).toContain(`user=${expected.user}\n`);
        expect(output).toContain(`hostname=${expected.hostName}\n`);
        expect(output).toContain(`port=${expected.port}\n`);
        expect(output).toContain("stricthostkeychecking=true\n");
        expect(output).toMatch(
          /userknownhostsfile=\/run\/forge-secure\/executions\/[a-f0-9]{24}\/ssh\/known_hosts\n/u,
        );
        expect(output).not.toContain(SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER);
      }

      const cleanupCheck = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            `current="$(basename "$(dirname "$TMPDIR")")"; test -z "$(find ${dockerSecureExecutionMetadata.secretRoot}/executions -mindepth 1 -maxdepth 1 ! -name "$current" -print -quit)"`,
          ],
        },
        guardOutput: passThroughGuard(),
      });
      expect(cleanupCheck.exitCode).toBe(0);
    }, 30_000);

    it("reuses one hardened same-path task sandbox for sixteen commands", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("reuse"),
      });
      const secureTask = task("reuse");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));

      const sandbox = await backend.ensureTask(secureTask);
      const initialInspect = await dockerInspect(sandbox.sandboxId);
      const initialId = initialInspect.Id;
      const bindingPath = "/run/forge-secure/bindings/reused-token";

      for (let index = 0; index < 16; index += 1) {
        const value = Buffer.from(`binding-value-${index}`);
        const result = await backend.execute({
          task: secureTask,
          command: {
            executable: "node",
            args: [
              "-e",
              `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(
                bindingPath,
              )}))`,
            ],
          },
          delivery: {
            ramFiles: [
              {
                targetPath: bindingPath,
                value,
                fileMode: 0o400,
              },
            ],
          },
          guardOutput: passThroughGuard(),
        });
        expect(result.exitCode).toBe(0);
        expect(Buffer.from(result.stdout).toString("utf8")).toBe(
          value.toString("utf8"),
        );
        expect((await dockerInspect(sandbox.sandboxId)).Id).toBe(initialId);
      }

      const concurrentValues = [
        Buffer.from("concurrent-first"),
        Buffer.from("concurrent-second"),
      ];
      const concurrent = await Promise.all(
        concurrentValues.map(async (value, index) =>
          await backend.execute({
            task: secureTask,
            command: {
              executable: "node",
              args: [
                "-e",
                `setTimeout(()=>process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(
                  bindingPath,
                )})),${index === 0 ? 150 : 0})`,
              ],
            },
            delivery: {
              ramFiles: [
                {
                  targetPath: bindingPath,
                  value,
                  fileMode: 0o400,
                },
              ],
            },
            guardOutput: passThroughGuard(),
          }),
        ),
      );
      expect(
        concurrent.map((result) =>
          Buffer.from(result.stdout).toString("utf8"),
        ),
      ).toEqual(concurrentValues.map((value) => value.toString("utf8")));

      const toolCheck = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            "for tool in bash cc curl git jq node npm pnpm psql python3 rsync script ssh; do command -v \"$tool\" >/dev/null || exit 9; done; getent passwd \"$(id -u)\" >/dev/null && getent group \"$(id -g)\" >/dev/null && ssh -G forge-secure.invalid >/dev/null",
          ],
        },
        guardOutput: passThroughGuard(),
      });
      expect(toolCheck.exitCode).toBe(0);

      const config = initialInspect.Config as Record<string, unknown>;
      const hostConfig = initialInspect.HostConfig as Record<string, unknown>;
      const mounts = initialInspect.Mounts as Array<Record<string, unknown>>;
      expect(config.User).not.toBe("");
      expect(config.User).not.toBe("0");
      expect(config.WorkingDir).toBe(workspacePath);
      expect(config.Labels).toEqual(
        expect.objectContaining({
          [dockerSecureExecutionMetadata.runnerContractLabel]:
            dockerSecureExecutionMetadata.runnerContractVersion,
        }),
      );
      expect(hostConfig.ReadonlyRootfs).toBe(true);
      expect(hostConfig.RestartPolicy).toEqual(
        expect.objectContaining({ Name: "no" }),
      );
      expect(hostConfig.CapDrop).toContain("ALL");
      expect(hostConfig.SecurityOpt).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^no-new-privileges(?:=true)?$/u),
        ]),
      );
      expect(hostConfig.Tmpfs).toHaveProperty(
        dockerSecureExecutionMetadata.secretRoot,
      );
      const bindMounts = mounts.filter((mount) => mount.Type === "bind");
      const gitCommonDirectory = await hostGitCommonDirectory();
      const expectedBindMounts: Array<Record<string, unknown>> = [
        expect.objectContaining({
          Source: workspacePath,
          Destination: workspacePath,
          RW: true,
        }),
        expect.objectContaining({
          Destination: dockerSecureExecutionMetadata.hostHeartbeatTarget,
          RW: false,
        }),
      ];
      if (gitCommonDirectory !== null) {
        expectedBindMounts.push(
          expect.objectContaining({
            Source: gitCommonDirectory,
            Destination: gitCommonDirectory,
            RW: true,
          }),
        );
      }
      expect(bindMounts).toHaveLength(expectedBindMounts.length);
      expect(bindMounts).toEqual(expect.arrayContaining(expectedBindMounts));
      expect(JSON.stringify(mounts)).not.toContain("/var/run/docker.sock");

      const gitRoot = await backend.execute({
        task: secureTask,
        command: {
          executable: "git",
          args: ["rev-parse", "--show-toplevel"],
        },
        guardOutput: passThroughGuard(),
      });
      expect(gitRoot.exitCode).toBe(0);
      expect(Buffer.from(gitRoot.stdout).toString("utf8").trim()).toBe(
        workspacePath,
      );

      const gitStatus = await backend.execute({
        task: secureTask,
        command: {
          executable: "git",
          args: ["status", "--short", "--untracked-files=no"],
        },
        guardOutput: passThroughGuard(),
      });
      expect(gitStatus.exitCode).toBe(0);
    }, 60_000);

    it("keeps values and the requested command out of Docker metadata and CLI argv", async () => {
      const canary = Buffer.from(
        `docker-metadata-canary-${randomBytes(12).toString("hex")}`,
      );
      const commandMarker = `command-marker-${randomBytes(8).toString("hex")}`;
      const invocations: string[][] = [];
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("metadata"),
        onDockerInvocation: ({ args }) => invocations.push([...args]),
      });
      const secureTask = task("metadata");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);

      const execution = backend.execute({
        task: secureTask,
        command: {
          executable: "node",
          args: [
            "-e",
            `setTimeout(()=>process.stdout.write(process.env.FORGE_CANARY+"${commandMarker}"),700)`,
          ],
        },
        delivery: {
          environment: [{ name: "FORGE_CANARY", value: canary }],
        },
        guardOutput: bufferingRedactionGuard([canary]),
      });

      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      const { stdout: topOutput } = await execFileAsync("docker", [
        "top",
        sandbox.sandboxId,
        "-eo",
        "pid,args",
      ]);
      const result = await execution;
      const inspectText = JSON.stringify(await dockerInspect(sandbox.sandboxId));
      const invocationText = JSON.stringify(invocations);

      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toBe(
        `[REDACTED]${commandMarker}`,
      );
      expect(inspectText).not.toContain(canary.toString("utf8"));
      expect(inspectText).not.toContain(secureTask.taskId);
      expect(topOutput).not.toContain(canary.toString("utf8"));
      expect(invocationText).not.toContain(canary.toString("utf8"));
      expect(invocationText).not.toContain(commandMarker);
      expect(invocations.some((args) => args.includes("-e"))).toBe(true);
      expect(invocations.some((args) => args.includes("-i"))).toBe(true);
      for (const args of invocations.filter(
        (invocation) => invocation.includes("exec"),
      )) {
        const containerIndex = args.indexOf(sandbox.sandboxId);
        expect(containerIndex).toBeGreaterThan(0);
        expect(args.slice(0, containerIndex)).not.toContain("-e");
        expect(args.slice(0, containerIndex)).not.toContain("--env");
      }
      expect(
        invocations.some((args) =>
          args.some((argument) => argument.startsWith("FORGE_CANARY=")),
        ),
      ).toBe(false);
    }, 30_000);

    it("delivers arbitrary file and stdin bytes only through the binary frame", async () => {
      const binary = Buffer.concat([
        Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]),
        randomBytes(59),
      ]);
      const expectedDigest = createHash("sha256").update(binary).digest("hex");
      const encodedNeedles = [binary.toString("hex"), binary.toString("base64")];
      const invocations: string[][] = [];
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("binary"),
        onDockerInvocation: ({ args }) => invocations.push([...args]),
      });
      const secureTask = task("binary");
      cleanupOperations.push(async () => {
        binary.fill(0);
        return await backend.destroyTask(secureTask);
      });
      const sandbox = await backend.ensureTask(secureTask);

      const result = await backend.execute({
        task: secureTask,
        command: {
          executable: "node",
          args: [
            "-e",
            [
              'const fs=require("node:fs");',
              'const crypto=require("node:crypto");',
              'const chunks=[];',
              'process.stdin.on("data",c=>chunks.push(c));',
              'process.stdin.on("end",()=>{',
              'const hash=v=>crypto.createHash("sha256").update(v).digest("hex");',
              'process.stdout.write(JSON.stringify({file:hash(fs.readFileSync("/run/forge-secure/bindings/binary")),stdin:hash(Buffer.concat(chunks))}));',
              "});",
            ].join(""),
          ],
        },
        delivery: {
          ramFiles: [
            {
              targetPath: "/run/forge-secure/bindings/binary",
              value: binary,
              fileMode: 0o400,
            },
          ],
          stdin: binary,
        },
        guardOutput: passThroughGuard(),
      });
      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toBe(
        JSON.stringify({
          file: expectedDigest,
          stdin: expectedDigest,
        }),
      );

      const metadata = `${JSON.stringify(
        await dockerInspect(sandbox.sandboxId),
      )}\n${JSON.stringify(invocations)}`;
      for (const needle of encodedNeedles) {
        expect(metadata).not.toContain(needle);
      }
    }, 30_000);

    it("guards environment, RAM-file, stdin, askpass, and stderr reflection before the caller", async () => {
      const environmentSecret = Buffer.from(
        `environment-${randomBytes(10).toString("hex")}`,
      );
      const fileSecret = Buffer.from(
        `ram-file-${randomBytes(10).toString("hex")}`,
      );
      const stdinSecret = Buffer.from(
        `stdin-${randomBytes(10).toString("hex")}`,
      );
      const askpassSecret = Buffer.from(
        `askpass-${randomBytes(10).toString("hex")}`,
      );
      const ambientName = `FORGE_AMBIENT_${randomBytes(5)
        .toString("hex")
        .toUpperCase()}`;
      process.env[ambientName] = "must-not-enter-guest";

      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("delivery"),
      });
      const secureTask = task("delivery");
      cleanupOperations.push(async () => {
        delete process.env[ambientName];
        return await backend.destroyTask(secureTask);
      });
      await backend.ensureTask(secureTask);

      const published: Buffer[] = [];
      const result = await backend.execute({
        task: secureTask,
        command: {
          executable: "node",
          args: [
            "-e",
            [
              'const fs=require("node:fs");',
              'const {spawnSync}=require("node:child_process");',
              'let input="";',
              'process.stdin.on("data",c=>input+=c);',
              'process.stdin.on("end",()=>{',
              "const output={",
              "environment:process.env.FORGE_ENV_SECRET,",
              "file:fs.readFileSync(process.env.FORGE_FILE_SECRET,'utf8'),",
              "mode:(fs.statSync(process.env.FORGE_FILE_SECRET).mode&0o777).toString(8),",
              "stdin:input,",
              "askpass:spawnSync(process.env.FORGE_ASKPASS,[],{encoding:'utf8'}).stdout,",
              "askpassMode:(fs.statSync(process.env.FORGE_ASKPASS).mode&0o777).toString(8),",
              `ambient:Object.hasOwn(process.env,${JSON.stringify(ambientName)})`,
              "};",
              "process.stdout.write(JSON.stringify(output));",
              "process.stderr.write(process.env.FORGE_ENV_SECRET);",
              "});",
            ].join(""),
          ],
        },
        delivery: {
          environment: [
            { name: "FORGE_ENV_SECRET", value: environmentSecret },
          ],
          ramFiles: [
            {
              targetPath: "/run/forge-secure/bindings/nested/credential",
              value: fileSecret,
              fileMode: 0o400,
              pathEnvironmentVariable: "FORGE_FILE_SECRET",
            },
          ],
          askpass: [
            {
              targetName: "FORGE_ASKPASS",
              value: askpassSecret,
            },
          ],
          stdin: stdinSecret,
        },
        guardOutput: bufferingRedactionGuard([
          environmentSecret,
          fileSecret,
          stdinSecret,
          askpassSecret,
        ]),
        onOutput: ({ bytes }) => published.push(Buffer.from(bytes)),
      });

      const callerVisible = Buffer.concat([
        Buffer.from(result.stdout),
        Buffer.from(result.stderr),
        ...published,
      ]).toString("utf8");
      expect(result.exitCode).toBe(0);
      expect(Buffer.from(result.stdout).toString("utf8")).toBe(
        JSON.stringify({
          environment: "[REDACTED]",
          file: "[REDACTED]",
          mode: "400",
          stdin: "[REDACTED]",
          askpass: "[REDACTED]",
          askpassMode: "700",
          ambient: false,
        }),
      );
      expect(Buffer.from(result.stderr).toString("utf8")).toBe("[REDACTED]");
      expect(callerVisible).not.toContain(environmentSecret.toString("utf8"));
      expect(callerVisible).not.toContain(fileSecret.toString("utf8"));
      expect(callerVisible).not.toContain(stdinSecret.toString("utf8"));
      expect(callerVisible).not.toContain(askpassSecret.toString("utf8"));

      const cleanupCheck = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            `current="$(basename "$(dirname "$TMPDIR")")"; test -z "$(find ${dockerSecureExecutionMetadata.secretRoot}/executions -mindepth 1 -maxdepth 1 ! -name "$current" -print -quit)" && test -z "$(find ${dockerSecureExecutionMetadata.secretRoot}/bindings -mindepth 1 -print -quit 2>/dev/null)" && test -z "$(find /tmp/forge-secure-askpass -mindepth 1 -print -quit 2>/dev/null)"`,
          ],
        },
        guardOutput: passThroughGuard(),
      });
      expect(cleanupCheck.exitCode).toBe(0);
    }, 30_000);

    it("cancellation and timeout fail closed by destroying and revoking the task", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("interrupt"),
      });
      const secureTask = task("interrupt");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const firstSandbox = await backend.ensureTask(secureTask);

      const abortController = new AbortController();
      const aborted = backend.execute({
        task: secureTask,
        command: { executable: "sleep", args: ["30"] },
        signal: abortController.signal,
        guardOutput: passThroughGuard(),
      });
      setTimeout(() => abortController.abort(), 100);
      await expect(aborted).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "EXECUTION_ABORTED",
        }),
      );
      expect(await dockerContainerExists(firstSandbox.sandboxId)).toBe(false);

      const secondSandbox = await backend.ensureTask(secureTask);
      await expect(
        backend.execute({
          task: secureTask,
          command: { executable: "sleep", args: ["30"] },
          timeoutMs: 100,
          guardOutput: passThroughGuard(),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "EXECUTION_TIMEOUT",
        }),
      );
      expect(await dockerContainerExists(secondSandbox.sandboxId)).toBe(false);
      await expect(
        backend.execute({
          task: secureTask,
          command: { executable: "true", args: [] },
          guardOutput: passThroughGuard(),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "TASK_REVOKED",
        }),
      );
    }, 30_000);

    it("destroys every concurrent exec when the shared task is revoked", async () => {
      let startedExecutions = 0;
      let markBothStarted: (() => void) | undefined;
      const bothStarted = new Promise<void>((resolveStarted) => {
        markBothStarted = resolveStarted;
      });
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("concurrent-revoke"),
        onDockerInvocation: ({ args }) => {
          if (!args.includes("exec") || !args.includes("-i")) return;
          startedExecutions += 1;
          if (startedExecutions === 2) markBothStarted?.();
        },
      });
      const secureTask = task("concurrent-revoke");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);

      const executions = [
        backend.execute({
          task: secureTask,
          command: { executable: "sleep", args: ["30"] },
          guardOutput: passThroughGuard(),
        }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
        backend.execute({
          task: secureTask,
          command: { executable: "sleep", args: ["30"] },
          guardOutput: passThroughGuard(),
        }).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      ];
      await bothStarted;
      await expect(backend.destroyTask(secureTask)).resolves.toBe(true);
      await expect(Promise.all(executions)).resolves.toEqual([
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "TASK_REVOKED" }),
        }),
        expect.objectContaining({
          status: "rejected",
          reason: expect.objectContaining({ code: "TASK_REVOKED" }),
        }),
      ]);
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
    }, 30_000);

    it("closes the abort race at Docker exec spawn", async () => {
      const abortController = new AbortController();
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("abort-spawn-race"),
        onDockerInvocation: ({ args }) => {
          if (args.includes("exec") && args.includes("-i")) {
            abortController.abort();
          }
        },
      });
      const secureTask = task("abort-spawn-race");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);

      await expect(backend.execute({
        task: secureTask,
        command: { executable: "sleep", args: ["1"] },
        signal: abortController.signal,
        guardOutput: passThroughGuard(),
      })).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "EXECUTION_ABORTED",
        }),
      );
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
    }, 30_000);

    it("waits for hard teardown before returning an output-guard failure", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("guard-failure"),
      });
      const secureTask = task("guard-failure");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);

      await expect(
        backend.execute({
          task: secureTask,
          command: {
            executable: "node",
            args: ["-e", 'process.stdout.write("unguarded")'],
          },
          guardOutput: () => {
            throw new Error("injected guard failure");
          },
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "GUARD_FAILED",
        }),
      );
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
      await expect(
        backend.execute({
          task: secureTask,
          command: { executable: "true", args: [] },
          guardOutput: passThroughGuard(),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "TASK_REVOKED",
        }),
      );
    }, 30_000);

    it("rejects a symlinked binding parent without writing outside tmpfs", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("binding-symlink"),
      });
      const secureTask = task("binding-symlink");
      const fileName = `.forge-secure-symlink-${randomBytes(8).toString("hex")}`;
      const workspaceTarget = `${workspacePath}/${fileName}`;
      cleanupOperations.push(
        async () => await rm(workspaceTarget, { force: true }),
        async () => await backend.destroyTask(secureTask),
      );
      const sandbox = await backend.ensureTask(secureTask);

      const poisoned = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            `rm -rf ${dockerSecureExecutionMetadata.secretRoot}/bindings && ln -s ${JSON.stringify(
              workspacePath,
            )} ${dockerSecureExecutionMetadata.secretRoot}/bindings`,
          ],
        },
        guardOutput: passThroughGuard(),
      });
      expect(poisoned.exitCode).toBe(0);

      await expect(
        backend.execute({
          task: secureTask,
          command: { executable: "true", args: [] },
          delivery: {
            ramFiles: [
              {
                targetPath: `${dockerSecureExecutionMetadata.secretRoot}/bindings/${fileName}`,
                value: Buffer.from("must-not-write"),
                fileMode: 0o400,
              },
            ],
          },
          guardOutput: passThroughGuard(),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "EXECUTION_FAILED",
        }),
      );
      await expect(access(workspaceTarget)).rejects.toThrow();
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
    }, 30_000);

    it("hard destroy kills detached descendants and blocks reuse until explicit reprovision", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("revoke"),
      });
      const secureTask = task("revoke");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);
      const firstContainerId = (await dockerInspect(sandbox.sandboxId)).Id;

      const detached = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            "nohup sleep 300 </dev/null >/dev/null 2>&1 & printf started",
          ],
        },
        guardOutput: passThroughGuard(),
      });
      expect(Buffer.from(detached.stdout).toString("utf8")).toBe("started");

      expect(await backend.destroyTask(secureTask)).toBe(true);
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
      await expect(
        backend.execute({
          task: secureTask,
          command: { executable: "true", args: [] },
          guardOutput: passThroughGuard(),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "TASK_REVOKED",
        }),
      );

      const reprovisioned = await backend.ensureTask(secureTask);
      expect(reprovisioned.sandboxId).toBe(sandbox.sandboxId);
      expect((await dockerInspect(reprovisioned.sandboxId)).Id).not.toBe(
        firstContainerId,
      );
    }, 30_000);

    it("returns after the direct shell exits while a background descendant continues", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("background"),
      });
      const secureTask = task("background");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      await backend.ensureTask(secureTask);
      const marker = join(
        workspacePath,
        `.forge-secure-background-${randomBytes(8).toString("hex")}`,
      );
      cleanupOperations.push(async () => await rm(marker, { force: true }));
      const startedAt = Date.now();

      const result = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: [
            "-c",
            `(sleep 2; printf complete > ${JSON.stringify(marker)}) &`,
          ],
        },
        guardOutput: passThroughGuard(),
      });

      expect(result.exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(access(marker)).rejects.toThrow();
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_300));
      await expect(access(marker)).resolves.toBeUndefined();
    }, 10_000);

    it("stops the container when the host heartbeat becomes stale", async () => {
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("deadman"),
      });
      const secureTask = task("deadman");
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));
      const sandbox = await backend.ensureTask(secureTask);
      const inspected = await dockerInspect(sandbox.sandboxId);
      const mounts = inspected.Mounts as Array<Record<string, unknown>>;
      const heartbeatMount = mounts.find(
        (mount) =>
          mount.Destination
            === dockerSecureExecutionMetadata.hostHeartbeatTarget,
      );
      expect(heartbeatMount).toEqual(expect.objectContaining({ RW: false }));
      const heartbeatPath = heartbeatMount?.Source;
      expect(typeof heartbeatPath).toBe("string");

      const guestWrite = await backend.execute({
        task: secureTask,
        command: {
          executable: "sh",
          args: ["-c", `touch ${dockerSecureExecutionMetadata.hostHeartbeatTarget}`],
        },
        guardOutput: passThroughGuard(),
      });
      expect(guestWrite.exitCode).not.toBe(0);
      await utimes(heartbeatPath as string, new Date(0), new Date(0));

      await waitForContainerRunningState(sandbox.sandboxId, false);
      const stopped = await dockerInspect(sandbox.sandboxId);
      expect(stopped.State).toEqual(
        expect.objectContaining({ Running: false, ExitCode: 71 }),
      );
    }, 10_000);

    it("stops descendants after the owning Forge process is SIGKILLed", async () => {
      const scope = uniqueScope("deadman-sigkill");
      const secureTask = task("deadman-sigkill");
      const { child, sandboxId } = await startCrashOwnedSandbox(
        scope,
        secureTask,
      );
      const inspected = await dockerInspect(sandboxId);
      const mounts = inspected.Mounts as Array<Record<string, unknown>>;
      const heartbeatPath = mounts.find(
        (mount) =>
          mount.Destination
            === dockerSecureExecutionMetadata.hostHeartbeatTarget,
      )?.Source;
      cleanupOperations.push(
        async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        },
        async () => {
          await execFileAsync("docker", [
            "rm",
            "-f",
            "--volumes",
            sandboxId,
          ]).catch(() => undefined);
        },
        async () => {
          if (typeof heartbeatPath === "string") {
            await rm(heartbeatPath, { force: true });
          }
        },
      );

      child.kill("SIGKILL");
      await new Promise<void>((resolveChild) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveChild();
          return;
        }
        child.once("close", () => resolveChild());
      });

      await waitForContainerRunningState(sandboxId, false, 22_000);
      const stopped = await dockerInspect(sandboxId);
      expect(stopped.State).toEqual(
        expect.objectContaining({ Running: false, ExitCode: 71 }),
      );
    }, 30_000);

    it("destroys a task after its workspace has been renamed away", async () => {
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "forge-secure-destroy-missing-workspace-"),
      );
      const temporaryWorkspace = join(temporaryRoot, "workspace");
      await mkdir(temporaryWorkspace);
      const canonicalWorkspace = await realpath(temporaryWorkspace);
      const canonicalMovedWorkspace = join(
        resolve(canonicalWorkspace, ".."),
        "workspace-moved",
      );
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("destroy-missing-workspace"),
      });
      const secureTask = {
        taskId: `destroy-missing-${randomBytes(8).toString("hex")}`,
        workspacePath: canonicalWorkspace,
      };
      cleanupOperations.push(
        async () => await rm(temporaryRoot, { recursive: true, force: true }),
        async () => await backend.destroyTask(secureTask),
      );
      const sandbox = await backend.ensureTask(secureTask);

      await rename(canonicalWorkspace, canonicalMovedWorkspace);
      await expect(backend.destroyTask(secureTask)).resolves.toBe(true);
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
    }, 30_000);

    it("serializes teardown against an in-flight sandbox creation", async () => {
      const secureTask = task("destroy-create-race");
      let destroying: Promise<boolean> | undefined;
      const backend = new DockerSecureExecutionBackend({
        scope: uniqueScope("destroy-create-race"),
        onDockerInvocation: ({ args }) => {
          if (args.includes("create") && destroying === undefined) {
            destroying = backend.destroyTask(secureTask);
          }
        },
      });
      cleanupOperations.push(async () => await backend.destroyTask(secureTask));

      const sandbox = await backend.ensureTask(secureTask);
      expect(destroying).toBeDefined();
      await expect(destroying).resolves.toBe(true);
      expect(await dockerContainerExists(sandbox.sandboxId)).toBe(false);
    }, 30_000);

    it("recovers only orphaned managed task sandboxes in its deterministic scope", async () => {
      const scope = uniqueScope("recovery");
      const original = new DockerSecureExecutionBackend({ scope });
      const restarted = new DockerSecureExecutionBackend({ scope });
      const retainedTask = task("retained");
      const orphanedTask = task("orphaned");
      cleanupOperations.push(
        async () => await restarted.destroyTask(retainedTask),
        async () => await restarted.destroyTask(orphanedTask),
      );
      const retained = await original.ensureTask(retainedTask);
      const orphaned = await original.ensureTask(orphanedTask);

      const recovery = await restarted.recoverOrphans([retainedTask]);
      expect(recovery.destroyedSandboxIds).toEqual([orphaned.sandboxId]);
      expect(await dockerContainerExists(retained.sandboxId)).toBe(true);
      expect(await dockerContainerExists(orphaned.sandboxId)).toBe(false);

      const retainedResult = await restarted.execute({
        task: retainedTask,
        command: { executable: "true", args: [] },
        guardOutput: passThroughGuard(),
      });
      expect(retainedResult.exitCode).toBe(0);
    }, 30_000);
  },
);

describe("Docker secure execution linked-worktree mount validation", () => {
  it("rejects a symlinked .git entry before invoking Docker", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-secure-git-symlink-"),
    );
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    const externalGitDirectory = join(temporaryRoot, "external.git");
    await mkdir(temporaryWorkspace);
    await mkdir(externalGitDirectory);
    await symlink(externalGitDirectory, join(temporaryWorkspace, ".git"));

    const backend = new DockerSecureExecutionBackend({
      scope: uniqueScope("git-symlink-rejection"),
    });
    await expect(
      backend.ensureTask({
        taskId: "git-symlink-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
  });

  it("rejects a .git pointer whose gitdir is outside a standard worktrees directory", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-secure-git-pointer-"),
    );
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    const commonDirectory = join(temporaryRoot, ".git");
    const rogueGitDirectory = join(temporaryRoot, "rogue-worktree-metadata");
    await mkdir(temporaryWorkspace);
    await mkdir(commonDirectory);
    await mkdir(rogueGitDirectory);
    await writeFile(
      join(temporaryWorkspace, ".git"),
      `gitdir: ${rogueGitDirectory}\n`,
    );
    await writeFile(
      join(rogueGitDirectory, "commondir"),
      `${commonDirectory}\n`,
    );

    const backend = new DockerSecureExecutionBackend({
      scope: uniqueScope("git-pointer-rejection"),
    });
    await expect(
      backend.ensureTask({
        taskId: "git-pointer-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
  });

  it("rejects a pointer to another repository's legitimate worktree metadata", async () => {
    const { stdout: gitDirectoryOutput } = await execFileAsync(
      "git",
      ["rev-parse", "--git-dir"],
      { cwd: workspacePath },
    );
    const reportedGitDirectory = gitDirectoryOutput.trim();
    const legitimateGitDirectory = await realpath(
      isAbsolute(reportedGitDirectory)
        ? reportedGitDirectory
        : resolve(workspacePath, reportedGitDirectory),
    );
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "forge-secure-cross-repo-git-pointer-"),
    );
    cleanupOperations.push(async () =>
      await rm(temporaryRoot, { recursive: true, force: true }),
    );
    const temporaryWorkspace = join(temporaryRoot, "workspace");
    await mkdir(temporaryWorkspace);
    await writeFile(
      join(temporaryWorkspace, ".git"),
      `gitdir: ${legitimateGitDirectory}\n`,
    );

    const backend = new DockerSecureExecutionBackend({
      scope: uniqueScope("cross-repo-git-pointer-rejection"),
    });
    await expect(
      backend.ensureTask({
        taskId: "cross-repo-git-pointer-rejection",
        workspacePath: temporaryWorkspace,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_TASK",
      }),
    );
  });
});

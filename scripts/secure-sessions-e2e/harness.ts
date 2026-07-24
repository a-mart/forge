import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const MANAGED_PREFIX = "forge-secure-e2e-";
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface FixtureImages {
  readonly runner: string;
  readonly target: string;
}

export interface FixtureTarget {
  readonly name: string;
  readonly ipAddress: string;
}

export interface FixtureDatabase extends FixtureTarget {}

function assertManagedName(value: string): void {
  if (!value.startsWith(MANAGED_PREFIX) || !/^[a-z0-9_.:-]+$/u.test(value)) {
    throw new Error("refusing to operate on an unmanaged e2e artifact");
  }
}

function assertSandboxName(value: string): void {
  if (!value.startsWith("forge-secure-") || !/^[a-z0-9_.:-]+$/u.test(value)) {
    throw new Error("refusing to inspect an unmanaged secure sandbox");
  }
}

export function uniqueManagedName(label: string): string {
  return `${MANAGED_PREFIX}${label}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    stdin?: Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode = -1): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
        return;
      }
      resolveResult({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    };
    const retain = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("e2e command output limit exceeded"));
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout.on("data", (chunk: Buffer) => retain(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => retain(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(options.stdin);

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("e2e command timed out"));
          }, options.timeoutMs);
  });
}

export async function buildFixtureImages(
  repositoryRoot: string,
  runnerImage: string,
  targetImage: string,
): Promise<FixtureImages> {
  assertManagedName(runnerImage);
  assertManagedName(targetImage);
  const context = resolve(repositoryRoot, "scripts/secure-sessions-e2e");
  for (const [target, image] of [
    ["runner", runnerImage],
    ["target", targetImage],
  ] as const) {
    const result = await runCommand(
      "docker",
      [
        "build",
        "--target",
        target,
        "--tag",
        image,
        context,
      ],
      { cwd: repositoryRoot, timeoutMs: 180_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`failed to build secure-session e2e ${target} image`);
    }
  }
  return { runner: runnerImage, target: targetImage };
}

export async function startFixtureTarget(
  image: string,
  name: string,
  password: Uint8Array,
): Promise<FixtureTarget> {
  assertManagedName(image);
  assertManagedName(name);
  const started = await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    image,
  ]);
  if (started.exitCode !== 0) {
    throw new Error("failed to start secure-session e2e target");
  }

  try {
    const passwordInput = Buffer.concat([
      Buffer.from("forge:", "utf8"),
      Buffer.from(password),
      Buffer.from("\n", "utf8"),
    ]);
    try {
      const changed = await runCommand(
        "docker",
        ["exec", "--interactive", name, "chpasswd"],
        { stdin: passwordInput, timeoutMs: 15_000 },
      );
      if (changed.exitCode !== 0) {
        throw new Error("failed to configure secure-session e2e target");
      }
    } finally {
      passwordInput.fill(0);
    }

    const inspected = await runCommand("docker", [
      "container",
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      name,
    ]);
    const ipAddress = inspected.stdout.toString("utf8").trim();
    if (inspected.exitCode !== 0 || !/^[0-9a-f:.]+$/iu.test(ipAddress)) {
      throw new Error("secure-session e2e target has no reachable address");
    }

    await waitForTarget(name);
    return { name, ipAddress };
  } catch (error) {
    await removeManagedContainer(name);
    throw error;
  }
}

async function waitForTarget(name: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runCommand(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080',{method:'POST',body:'ready'}).then(async r=>{if(await r.text()!=='ready')process.exit(2)}).catch(()=>process.exit(3))",
      ],
      { timeoutMs: 5_000 },
    );
    if (result.exitCode === 0) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("secure-session e2e target did not become ready");
}

export async function startFixtureDatabase(
  name: string,
  password: Uint8Array,
): Promise<FixtureDatabase> {
  assertManagedName(name);
  const started = await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--env",
    "POSTGRES_PASSWORD=forge-e2e-bootstrap-only",
    "postgres:17-alpine",
  ], { timeoutMs: 120_000 });
  if (started.exitCode !== 0) {
    throw new Error("failed to start secure-session e2e database");
  }

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await runCommand(
        "docker",
        ["exec", name, "pg_isready", "--username", "postgres"],
        { timeoutMs: 5_000 },
      );
      if (ready.exitCode === 0) break;
      if (attempt === 79) {
        throw new Error("secure-session e2e database did not become ready");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }

    const passwordText = Buffer.from(password).toString("utf8");
    if (
      passwordText.length === 0
      || passwordText.includes("\0")
      || !Buffer.from(passwordText, "utf8").equals(password)
    ) {
      throw new Error("invalid secure-session e2e database password");
    }
    const sql = Buffer.from(
      `ALTER USER postgres PASSWORD '${passwordText.replaceAll("'", "''")}';\n`,
      "utf8",
    );
    try {
      let configured = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const changed = await runCommand(
          "docker",
          [
            "exec",
            "--interactive",
            name,
            "psql",
            "--username",
            "postgres",
            "--dbname",
            "postgres",
            "--file",
            "-",
          ],
          { stdin: sql, timeoutMs: 15_000 },
        );
        if (changed.exitCode === 0) {
          configured = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      if (!configured) {
        throw new Error("failed to configure secure-session e2e database");
      }
    } finally {
      sql.fill(0);
    }

    const inspected = await runCommand("docker", [
      "container",
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      name,
    ]);
    const ipAddress = inspected.stdout.toString("utf8").trim();
    if (inspected.exitCode !== 0 || !/^[0-9a-f:.]+$/iu.test(ipAddress)) {
      throw new Error("secure-session e2e database has no reachable address");
    }
    return { name, ipAddress };
  } catch (error) {
    await removeManagedContainer(name);
    throw error;
  }
}

export async function removeManagedContainer(name: string): Promise<void> {
  assertManagedName(name);
  await runCommand("docker", ["rm", "--force", "--volumes", name]);
}

export async function removeManagedImage(name: string): Promise<void> {
  assertManagedName(name);
  await runCommand("docker", ["image", "rm", "--force", name]);
}

export async function dockerContainerExists(name: string): Promise<boolean> {
  assertSandboxName(name);
  const result = await runCommand("docker", ["container", "inspect", name]);
  return result.exitCode === 0;
}

export async function collectDockerEvidence(input: {
  sandboxName: string;
  runnerImage: string;
  targetName: string;
  targetImage: string;
  outputDirectory: string;
}): Promise<Array<{ path: string; bytes: Buffer }>> {
  assertSandboxName(input.sandboxName);
  assertManagedName(input.runnerImage);
  assertManagedName(input.targetName);
  assertManagedName(input.targetImage);
  await mkdir(input.outputDirectory, { recursive: true });
  const exportedPath = resolve(input.outputDirectory, "sandbox-export.tar");
  const evidenceCommands = [
    ["sandbox-inspect.json", ["container", "inspect", input.sandboxName]],
    ["sandbox-logs.txt", ["logs", input.sandboxName]],
    ["sandbox-diff.txt", ["diff", input.sandboxName]],
    ["runner-history.txt", ["history", "--no-trunc", input.runnerImage]],
    ["target-inspect.json", ["container", "inspect", input.targetName]],
    ["target-logs.txt", ["logs", input.targetName]],
    ["target-history.txt", ["history", "--no-trunc", input.targetImage]],
  ] as const;
  const evidence: Array<{ path: string; bytes: Buffer }> = [];
  for (const [path, args] of evidenceCommands) {
    const result = await runCommand("docker", args, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`failed to collect Docker evidence: ${path}`);
    }
    evidence.push({
      path,
      bytes: Buffer.concat([result.stdout, result.stderr]),
    });
  }
  const exported = await runCommand(
    "docker",
    ["export", "--output", exportedPath, input.sandboxName],
    { timeoutMs: 60_000 },
  );
  if (exported.exitCode !== 0) {
    throw new Error("failed to export secure-session e2e sandbox");
  }
  return evidence;
}

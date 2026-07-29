/**
 * This fixed helper is the only command placed in Docker exec metadata. The
 * requested executable, arguments, and material arrive in one binary stdin
 * frame. Keep this source dependency-free so a stock Node image can run it.
 */
export const DOCKER_GUEST_EXECUTOR_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAGIC = Buffer.from("FSEC0001", "ascii");
const PREFIX_BYTES = 12;
const MAX_FRAME_BYTES = 17 * 1024 * 1024;
const ROOT = "/run/forge-secure/executions";
const MATERIAL_ROOT = "/run/forge-secure/bindings";
const ASKPASS_ROOT = "/tmp/forge-secure-askpass";
const SSH_WRAPPER_ROOT = "/tmp/forge-secure-ssh";
const NSS_WRAPPER_LIBRARY = "/usr/local/lib/forge/libnss_wrapper.so";
const SSH_KNOWN_HOSTS_PLACEHOLDER = "__FORGE_SECURE_SSH_KNOWN_HOSTS__";
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTION_ID = /^[a-f0-9]{24}$/;

function fail(code, exitCode = 125) {
  process.stderr.write("forge-secure-executor:" + code + "\n");
  process.exitCode = exitCode;
}

function validMaterialPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith(MATERIAL_ROOT + "/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.normalize(value) !== value
  ) {
    return false;
  }
  return true;
}

function takeMaterial(frame, state, byteLength) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    state.offset + byteLength > frame.byteLength
  ) {
    throw new Error("invalid-material");
  }
  const value = Buffer.from(frame.subarray(state.offset, state.offset + byteLength));
  state.offset += byteLength;
  return value;
}

function decodeEnvironmentValue(bytes) {
  const value = bytes.toString("utf8");
  if (value.includes("\0") || !Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error("invalid-environment");
  }
  return value;
}

function decodeTextMaterial(bytes) {
  const value = bytes.toString("utf8");
  if (value.includes("\0") || !Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error("invalid-text-material");
  }
  return value;
}

function cleanEnvironment(tmpDirectory) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp/forge-secure-home",
    USER: "forge",
    LOGNAME: "forge",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: tmpDirectory,
  };
}

function databaseEntry(database, idIndex, id) {
  const expected = String(id);
  for (const line of database.split("\n")) {
    const fields = line.split(":");
    if (fields[idIndex] === expected) {
      return fields;
    }
  }
  return undefined;
}

function unusedDatabaseName(database, preferred) {
  const names = new Set(
    database
      .split("\n")
      .map((line) => line.split(":")[0])
      .filter(Boolean),
  );
  if (!names.has(preferred)) {
    return preferred;
  }
  let suffix = 1;
  while (names.has(preferred + "-" + String(suffix))) {
    suffix += 1;
  }
  return preferred + "-" + String(suffix);
}

function appendDatabaseEntry(database, entry) {
  return (
    database +
    (database.length === 0 || database.endsWith("\n") ? "" : "\n") +
    entry +
    "\n"
  );
}

function ensureExecutionIdentity(executionRoot, environment) {
  const uid = process.getuid();
  const gid = process.getgid();
  const passwd = fs.readFileSync("/etc/passwd", "utf8");
  const group = fs.readFileSync("/etc/group", "utf8");
  const passwdEntry = databaseEntry(passwd, 2, uid);
  const groupEntry = databaseEntry(group, 2, gid);

  if (passwdEntry && groupEntry) {
    environment.USER = passwdEntry[0];
    environment.LOGNAME = passwdEntry[0];
    return;
  }
  if (!fs.existsSync(NSS_WRAPPER_LIBRARY)) {
    return;
  }

  const identityRoot = path.join(executionRoot, "identity");
  fs.mkdirSync(identityRoot, { mode: 0o700 });
  const userName =
    passwdEntry?.[0] || unusedDatabaseName(passwd, "forge-secure");
  const groupName =
    groupEntry?.[0] || unusedDatabaseName(group, "forge-secure");
  const wrappedPasswd = passwdEntry
    ? passwd
    : appendDatabaseEntry(
        passwd,
        userName +
          ":x:" +
          String(uid) +
          ":" +
          String(gid) +
          ":Forge Secure Runner:/tmp/forge-secure-home:/bin/sh",
      );
  const wrappedGroup = groupEntry
    ? group
    : appendDatabaseEntry(
        group,
        groupName + ":x:" + String(gid) + ":",
      );
  const passwdPath = path.join(identityRoot, "passwd");
  const groupPath = path.join(identityRoot, "group");
  fs.writeFileSync(passwdPath, wrappedPasswd, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(groupPath, wrappedGroup, { flag: "wx", mode: 0o600 });

  // The wrapper is fixed in the read-only runner image. Per-execution NSS
  // databases preserve the image's system identities and add only the mapped
  // host UID/GID when those numeric identities are otherwise unknown.
  environment.LD_PRELOAD = NSS_WRAPPER_LIBRARY;
  environment.NSS_WRAPPER_PASSWD = passwdPath;
  environment.NSS_WRAPPER_GROUP = groupPath;
  environment.USER = userName;
  environment.LOGNAME = userName;
}

function ensureDirectory(pathValue) {
  try {
    const existing = fs.lstatSync(pathValue);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("unsafe-directory");
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    try {
      fs.mkdirSync(pathValue, { mode: 0o700 });
    } catch (createError) {
      // Two execution-local deliveries may initialize the shared empty parent
      // concurrently. EEXIST is safe only after the lstat validation below.
      if (!createError || createError.code !== "EEXIST") {
        throw createError;
      }
    }
    const created = fs.lstatSync(pathValue);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error("unsafe-directory");
    }
  }
}

function ensureMaterialParent(filePath) {
  ensureDirectory(MATERIAL_ROOT);
  const relativeParent = path.relative(MATERIAL_ROOT, path.dirname(filePath));
  let current = MATERIAL_ROOT;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    ensureDirectory(current);
  }
}

function materializeFiles(frame, state, header, environment, createdFiles) {
  ensureDirectory(MATERIAL_ROOT);

  for (const descriptor of header.ramFiles) {
    if (
      !descriptor ||
      !validMaterialPath(descriptor.targetPath) ||
      (descriptor.fileMode !== 0o400 && descriptor.fileMode !== 0o600) ||
      (descriptor.pathEnvironmentVariable !== undefined &&
        !ENVIRONMENT_NAME.test(descriptor.pathEnvironmentVariable))
    ) {
      throw new Error("invalid-file");
    }

    const bytes = takeMaterial(frame, state, descriptor.byteLength);
    const filePath = descriptor.targetPath;

    ensureMaterialParent(filePath);
    const descriptorFlags =
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW || 0);
    const fileDescriptor = fs.openSync(filePath, descriptorFlags, descriptor.fileMode);
    createdFiles.push(filePath);
    try {
      fs.writeFileSync(fileDescriptor, bytes);
      fs.fchmodSync(fileDescriptor, descriptor.fileMode);
    } finally {
      fs.closeSync(fileDescriptor);
      bytes.fill(0);
    }

    if (descriptor.pathEnvironmentVariable) {
      environment[descriptor.pathEnvironmentVariable] = filePath;
    }
  }
}

function cleanupMaterializedFiles(createdFiles) {
  for (const filePath of [...createdFiles].reverse()) {
    fs.rmSync(filePath, { force: true });
    let directory = path.dirname(filePath);
    while (directory !== MATERIAL_ROOT && directory.startsWith(MATERIAL_ROOT + "/")) {
      try {
        fs.rmdirSync(directory);
      } catch {
        break;
      }
      directory = path.dirname(directory);
    }
  }
}

function materializeAskpass(frame, state, header, executionRoot, environment) {
  if (header.askpass.length === 0) {
    return;
  }
  const secretRoot = path.join(executionRoot, "askpass");
  const helperRoot = path.join(ASKPASS_ROOT, header.executionId);
  fs.mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(helperRoot, { recursive: true, mode: 0o700 });

  header.askpass.forEach((descriptor, index) => {
    if (
      !descriptor ||
      descriptor.index !== index ||
      !ENVIRONMENT_NAME.test(descriptor.targetName)
    ) {
      throw new Error("invalid-askpass");
    }

    const bytes = takeMaterial(frame, state, descriptor.byteLength);
    const secretPath = path.join(secretRoot, String(index));
    const helperPath = path.join(helperRoot, "askpass-" + String(index));
    try {
      fs.writeFileSync(secretPath, bytes, {
        flag: "wx",
        mode: 0o400,
      });
      fs.chmodSync(secretPath, 0o400);
    } finally {
      bytes.fill(0);
    }

    const helper =
      "#!/bin/sh\nexec /bin/cat " + JSON.stringify(secretPath) + "\n";
    fs.writeFileSync(helperPath, helper, {
      flag: "wx",
      mode: 0o700,
    });
    fs.chmodSync(helperPath, 0o700);
    environment[descriptor.targetName] = helperPath;
    if (descriptor.targetName === "SSH_ASKPASS") {
      // OpenSSH normally invokes askpass only for graphical sessions. Secure
      // Bash is intentionally pipe-based, so provide the non-sensitive flags
      // that make password authentication work without manufacturing a PTY.
      environment.DISPLAY = environment.DISPLAY || "forge-secure";
      environment.SSH_ASKPASS_REQUIRE =
        environment.SSH_ASKPASS_REQUIRE || "force";
    }
  });
}

function materializeSshTrust(frame, state, header, executionRoot, environment) {
  if (header.sshTrust === null) {
    return;
  }
  const descriptor = header.sshTrust;
  if (
    !descriptor ||
    !Number.isSafeInteger(descriptor.configByteLength) ||
    descriptor.configByteLength <= 0 ||
    !Number.isSafeInteger(descriptor.knownHostsByteLength) ||
    descriptor.knownHostsByteLength <= 0
  ) {
    throw new Error("invalid-ssh-trust");
  }

  const configBytes = takeMaterial(frame, state, descriptor.configByteLength);
  const knownHostsBytes = takeMaterial(
    frame,
    state,
    descriptor.knownHostsByteLength,
  );
  const sshRoot = path.join(executionRoot, "ssh");
  const wrapperRoot = path.join(SSH_WRAPPER_ROOT, header.executionId);
  const configPath = path.join(sshRoot, "config");
  const knownHostsPath = path.join(sshRoot, "known_hosts");
  const wrapperPath = path.join(wrapperRoot, "ssh");
  const bashEnvironmentPath = path.join(executionRoot, "bash-env");

  try {
    const config = decodeTextMaterial(configBytes);
    const knownHosts = decodeTextMaterial(knownHostsBytes);
    if (!config.includes(SSH_KNOWN_HOSTS_PLACEHOLDER)) {
      throw new Error("invalid-ssh-config");
    }
    const materializedConfig = config.replaceAll(
      SSH_KNOWN_HOSTS_PLACEHOLDER,
      knownHostsPath,
    );
    if (materializedConfig.includes(SSH_KNOWN_HOSTS_PLACEHOLDER)) {
      throw new Error("invalid-ssh-config");
    }

    fs.mkdirSync(sshRoot, { mode: 0o700 });
    ensureDirectory(SSH_WRAPPER_ROOT);
    fs.mkdirSync(wrapperRoot, { mode: 0o700 });
    fs.writeFileSync(knownHostsPath, knownHosts, {
      flag: "wx",
      mode: 0o400,
    });
    fs.writeFileSync(configPath, materializedConfig, {
      flag: "wx",
      mode: 0o400,
    });
    const wrapper =
      "#!/bin/sh\n" +
      "exec /usr/bin/ssh -F " +
      JSON.stringify(configPath) +
      " -o StrictHostKeyChecking=yes \"$@\"\n";
    fs.writeFileSync(wrapperPath, wrapper, {
      flag: "wx",
      mode: 0o700,
    });
    const bashEnvironment =
      "ssh() { " +
      JSON.stringify(wrapperPath) +
      " \"$@\"; }\n" +
      "export -f ssh\n" +
      "export PATH=" +
      JSON.stringify(wrapperRoot) +
      ":\"$" +
      "{PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}\"\n";
    fs.writeFileSync(bashEnvironmentPath, bashEnvironment, {
      flag: "wx",
      mode: 0o400,
    });
    environment.PATH = wrapperRoot + ":" + environment.PATH;
    environment.BASH_ENV = bashEnvironmentPath;
  } finally {
    configBytes.fill(0);
    knownHostsBytes.fill(0);
  }
}

async function main(frame) {
  if (
    frame.byteLength < PREFIX_BYTES ||
    !frame.subarray(0, MAGIC.byteLength).equals(MAGIC)
  ) {
    throw new Error("invalid-frame");
  }

  const headerByteLength = frame.readUInt32BE(MAGIC.byteLength);
  if (
    headerByteLength <= 0 ||
    PREFIX_BYTES + headerByteLength > frame.byteLength
  ) {
    throw new Error("invalid-frame");
  }

  const header = JSON.parse(
    frame.subarray(PREFIX_BYTES, PREFIX_BYTES + headerByteLength).toString("utf8"),
  );
  if (
    !header ||
    header.version !== 1 ||
    !EXECUTION_ID.test(header.executionId) ||
    !header.command ||
    typeof header.command.executable !== "string" ||
    !header.command.executable ||
    !Array.isArray(header.command.args) ||
    !header.command.args.every((argument) => typeof argument === "string") ||
    typeof header.command.cwd !== "string" ||
    !Array.isArray(header.environment) ||
    !Array.isArray(header.ramFiles) ||
    !Array.isArray(header.askpass) ||
    !Object.prototype.hasOwnProperty.call(header, "sshTrust")
  ) {
    throw new Error("invalid-header");
  }

  const executionRoot = path.join(ROOT, header.executionId);
  const tmpDirectory = path.join(executionRoot, "tmp");
  fs.mkdirSync(tmpDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync("/tmp/forge-secure-home", { recursive: true, mode: 0o700 });

  const state = { offset: PREFIX_BYTES + headerByteLength };
  const environment = cleanEnvironment(tmpDirectory);
  for (const descriptor of header.environment) {
    if (!descriptor || !ENVIRONMENT_NAME.test(descriptor.name)) {
      throw new Error("invalid-environment");
    }
    const bytes = takeMaterial(frame, state, descriptor.byteLength);
    try {
      environment[descriptor.name] = decodeEnvironmentValue(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  const createdFiles = [];
  try {
    materializeFiles(frame, state, header, environment, createdFiles);
    materializeAskpass(frame, state, header, executionRoot, environment);
    materializeSshTrust(frame, state, header, executionRoot, environment);
    ensureExecutionIdentity(executionRoot, environment);
    const childStdin = takeMaterial(frame, state, header.stdinByteLength);
    if (state.offset !== frame.byteLength) {
      childStdin.fill(0);
      throw new Error("invalid-frame");
    }

    const child = spawn(header.command.executable, header.command.args, {
      cwd: header.command.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    // Fast commands may close stdin before an empty or short credential frame
    // is flushed. That is a normal child behavior, not an executor failure.
    child.stdin.on("error", () => {});
    child.stdin.end(childStdin, () => childStdin.fill(0));

    const streamsClosed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", () =>
        settle({ spawnError: true, code: 127, signal: null }),
      );
      child.once("exit", (code, signal) =>
        settle({ spawnError: false, code: code === null ? 128 : code, signal }),
      );
    });
    // Match ordinary local Bash behavior: after the direct child exits, allow
    // a short pipe-drain grace period, then detach inherited descriptors held
    // by background descendants instead of blocking the tool until they exit.
    await Promise.race([
      streamsClosed,
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    child.stdout.unpipe(process.stdout);
    child.stderr.unpipe(process.stderr);
    child.stdout.destroy();
    child.stderr.destroy();
    frame.fill(0);

    if (outcome.spawnError) {
      fail("command-spawn-failed", outcome.code);
      return;
    }
    process.exitCode = outcome.code;
  } finally {
    cleanupMaterializedFiles(createdFiles);
  }
}

const chunks = [];
let totalBytes = 0;
process.stdin.on("data", (chunk) => {
  totalBytes += chunk.byteLength;
  if (totalBytes > MAX_FRAME_BYTES) {
    fail("frame-too-large");
    process.stdin.destroy();
    return;
  }
  chunks.push(Buffer.from(chunk));
});
process.stdin.once("end", async () => {
  const frame = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  let executionRoot;
  try {
    if (frame.byteLength >= PREFIX_BYTES) {
      const headerByteLength = frame.readUInt32BE(MAGIC.byteLength);
      const parsed = JSON.parse(
        frame.subarray(PREFIX_BYTES, PREFIX_BYTES + headerByteLength).toString("utf8"),
      );
      if (parsed && EXECUTION_ID.test(parsed.executionId)) {
        executionRoot = path.join(ROOT, parsed.executionId);
      }
    }
    await main(frame);
  } catch {
    frame.fill(0);
    fail("invalid-request");
  } finally {
    if (executionRoot) {
      try {
        fs.rmSync(executionRoot, { recursive: true, force: true });
        fs.rmSync(path.join(ASKPASS_ROOT, path.basename(executionRoot)), {
          recursive: true,
          force: true,
        });
        fs.rmSync(path.join(SSH_WRAPPER_ROOT, path.basename(executionRoot)), {
          recursive: true,
          force: true,
        });
      } catch {
        fail("cleanup-failed");
      }
    }
  }
});
`;

export const DOCKER_HEARTBEAT_PATH = "/run/forge-secure-host-heartbeat";
export const DOCKER_HEARTBEAT_INTERVAL_MS = 4_000;
export const DOCKER_HEARTBEAT_TTL_MS = 15_000;

/**
 * PID 1 exits when its host-owned heartbeat becomes stale. Docker then tears
 * down every descendant and unmounts the secret tmpfs even if Forge itself
 * was SIGKILLed and never had a chance to issue `docker rm`.
 */
export const DOCKER_KEEPALIVE_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const heartbeatPath = "/run/forge-secure-host-heartbeat";
const ttlMs = 15000;
function stop(code) {
  process.exit(code);
}
try {
  const heartbeat = fs.lstatSync(heartbeatPath);
  if (!heartbeat.isFile() || heartbeat.isSymbolicLink()) stop(70);
} catch {
  stop(70);
}
process.on("SIGTERM", () => stop(0));
setInterval(() => {
  try {
    if (Date.now() - fs.statSync(heartbeatPath).mtimeMs > ttlMs) stop(71);
  } catch {
    stop(72);
  }
}, 1000).unref();
setInterval(() => {}, 2147483647);
`;

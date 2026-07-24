import { Buffer } from "node:buffer";
import { posix } from "node:path";
import type {
  SecureExecutionCommand,
  SecureExecutionDelivery,
} from "./secure-execution-backend.js";
import { SecureExecutionError } from "./secure-execution-error.js";

const FRAME_MAGIC = Buffer.from("FSEC0001", "ascii");
const FRAME_PREFIX_BYTES = FRAME_MAGIC.byteLength + 4;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_MATERIAL_BYTES = 16 * 1024 * 1024;
const MAX_BINDINGS = 256;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXECUTION_ID = /^[a-f0-9]{24}$/;
const MATERIAL_ROOT = "/run/forge-secure/bindings";
export const SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "USER",
] as const;

interface MaterialDescriptor {
  byteLength: number;
}

interface EnvironmentDescriptor extends MaterialDescriptor {
  name: string;
}

interface RamFileDescriptor extends MaterialDescriptor {
  targetPath: string;
  fileMode: 0o400 | 0o600;
  pathEnvironmentVariable?: string;
}

interface AskpassDescriptor extends MaterialDescriptor {
  targetName: string;
  index: number;
}

export interface SecureExecutionFrameHeader {
  version: 1;
  executionId: string;
  command: {
    executable: string;
    args: string[];
    cwd: string;
  };
  environment: EnvironmentDescriptor[];
  ramFiles: RamFileDescriptor[];
  askpass: AskpassDescriptor[];
  stdinByteLength: number;
}

function assertEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME.test(name)) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }
}

function assertMaterialFilePath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    path !== normalized ||
    !path.startsWith(`${MATERIAL_ROOT}/`) ||
    path.includes("\0") ||
    path.includes("\\")
  ) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }
}

function assertCommand(command: SecureExecutionCommand, workspacePath: string): void {
  if (
    !command.executable ||
    command.executable.includes("\0") ||
    command.args.some((argument) => argument.includes("\0")) ||
    !workspacePath ||
    workspacePath.includes("\0")
  ) {
    throw new SecureExecutionError("INVALID_COMMAND");
  }
}

function copyMaterial(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }
  return Buffer.from(value);
}

function buildEnvironmentDescriptors(
  delivery: SecureExecutionDelivery,
  material: Buffer[],
  environmentNames: Set<string>,
): EnvironmentDescriptor[] {
  const environment = delivery.environment ?? [];
  if (environment.length > MAX_BINDINGS) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }

  return environment.map((binding) => {
    assertEnvironmentName(binding.name);
    if (environmentNames.has(binding.name)) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }
    environmentNames.add(binding.name);

    const value = copyMaterial(binding.value);
    material.push(value);
    return { name: binding.name, byteLength: value.byteLength };
  });
}

function buildRamFileDescriptors(
  delivery: SecureExecutionDelivery,
  material: Buffer[],
  environmentNames: Set<string>,
): RamFileDescriptor[] {
  const ramFiles = delivery.ramFiles ?? [];
  if (ramFiles.length > MAX_BINDINGS) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }

  const paths = new Set<string>();
  return ramFiles.map((binding) => {
    assertMaterialFilePath(binding.targetPath);
    if (paths.has(binding.targetPath)) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }
    paths.add(binding.targetPath);
    if (
      binding.fileMode !== undefined &&
      binding.fileMode !== 0o400 &&
      binding.fileMode !== 0o600
    ) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }

    if (binding.pathEnvironmentVariable) {
      assertEnvironmentName(binding.pathEnvironmentVariable);
      if (environmentNames.has(binding.pathEnvironmentVariable)) {
        throw new SecureExecutionError("INVALID_DELIVERY");
      }
      environmentNames.add(binding.pathEnvironmentVariable);
    }

    const value = copyMaterial(binding.value);
    material.push(value);
    return {
      targetPath: binding.targetPath,
      fileMode: binding.fileMode ?? 0o400,
      byteLength: value.byteLength,
      ...(binding.pathEnvironmentVariable
        ? { pathEnvironmentVariable: binding.pathEnvironmentVariable }
        : {}),
    };
  });
}

function buildAskpassDescriptors(
  delivery: SecureExecutionDelivery,
  material: Buffer[],
  environmentNames: Set<string>,
): AskpassDescriptor[] {
  const askpass = delivery.askpass ?? [];
  if (askpass.length > MAX_BINDINGS) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }

  return askpass.map((binding, index) => {
    assertEnvironmentName(binding.targetName);
    if (environmentNames.has(binding.targetName)) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }
    environmentNames.add(binding.targetName);

    const value = copyMaterial(binding.value);
    material.push(value);
    return {
      targetName: binding.targetName,
      index,
      byteLength: value.byteLength,
    };
  });
}

function zeroBuffers(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) {
    buffer.fill(0);
  }
}

export function encodeSecureExecutionFrame(input: {
  executionId: string;
  command: SecureExecutionCommand;
  workspacePath: string;
  delivery?: SecureExecutionDelivery;
}): Buffer {
  if (!EXECUTION_ID.test(input.executionId)) {
    throw new SecureExecutionError("INVALID_DELIVERY");
  }
  assertCommand(input.command, input.workspacePath);

  const delivery = input.delivery ?? {};
  const material: Buffer[] = [];
  try {
    const environmentNames = new Set<string>(
      SECURE_RESERVED_GUEST_ENVIRONMENT_NAMES,
    );
    const environment = buildEnvironmentDescriptors(
      delivery,
      material,
      environmentNames,
    );
    const ramFiles = buildRamFileDescriptors(
      delivery,
      material,
      environmentNames,
    );
    const askpass = buildAskpassDescriptors(
      delivery,
      material,
      environmentNames,
    );
    const stdin = delivery.stdin ? copyMaterial(delivery.stdin) : Buffer.alloc(0);
    material.push(stdin);

    const materialByteLength = material.reduce(
      (total, value) => total + value.byteLength,
      0,
    );
    if (materialByteLength > MAX_MATERIAL_BYTES) {
      throw new SecureExecutionError("INVALID_DELIVERY");
    }

    const header: SecureExecutionFrameHeader = {
      version: 1,
      executionId: input.executionId,
      command: {
        executable: input.command.executable,
        args: [...input.command.args],
        cwd: input.command.cwd ?? input.workspacePath,
      },
      environment,
      ramFiles,
      askpass,
      stdinByteLength: stdin.byteLength,
    };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    if (headerBytes.byteLength > MAX_HEADER_BYTES) {
      headerBytes.fill(0);
      throw new SecureExecutionError("INVALID_DELIVERY");
    }

    const frame = Buffer.allocUnsafe(
      FRAME_PREFIX_BYTES + headerBytes.byteLength + materialByteLength,
    );
    FRAME_MAGIC.copy(frame, 0);
    frame.writeUInt32BE(headerBytes.byteLength, FRAME_MAGIC.byteLength);
    headerBytes.copy(frame, FRAME_PREFIX_BYTES);
    headerBytes.fill(0);

    let offset = FRAME_PREFIX_BYTES + frame.readUInt32BE(FRAME_MAGIC.byteLength);
    for (const value of material) {
      value.copy(frame, offset);
      offset += value.byteLength;
    }
    return frame;
  } finally {
    zeroBuffers(material);
  }
}

export const secureExecutionFrameConstants = Object.freeze({
  magic: FRAME_MAGIC.toString("ascii"),
  prefixBytes: FRAME_PREFIX_BYTES,
  maxHeaderBytes: MAX_HEADER_BYTES,
  maxMaterialBytes: MAX_MATERIAL_BYTES,
});

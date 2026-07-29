import { createHash } from "node:crypto";
import type {
  SecureSshTrustedHostSummary,
} from "@forge/protocol";
import type {
  SecureSessionSshTrustedHost,
} from "./storage/types.js";
import {
  SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER,
} from "./execution/secure-execution-backend.js";

export const SECURE_SSH_RESERVED_BINDING_PREFIX =
  "/run/forge-secure/bindings/.forge-ssh/";

const SUPPORTED_HOST_KEY_ALGORITHMS = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

export interface NormalizedSshHostKey {
  hostKeyAlgorithm: string;
  hostKeyBase64: string;
  hostKeyFingerprint: string;
}

export interface NormalizedSshTrustedHostInput extends NormalizedSshHostKey {
  alias: string;
  hostName: string;
  port: number;
  username: string;
}

export function normalizeSshTrustedHostInput(input: {
  alias: string;
  hostName: string;
  port?: number;
  username: string;
  hostKey: string;
}): NormalizedSshTrustedHostInput {
  return {
    alias: normalizeAlias(input.alias),
    hostName: normalizeToken(input.hostName, "SSH host name", 512),
    port: normalizePort(input.port ?? 22),
    username: normalizeToken(input.username, "SSH username", 256),
    ...normalizeSshHostKeyText(input.hostKey),
  };
}

export function normalizeProposedSshTrustedHost(input: {
  alias: string;
  hostName: string;
  port: number;
  username: string;
  hostKeyAlgorithm: string;
  hostKeyBase64: string;
}): NormalizedSshTrustedHostInput {
  return {
    alias: normalizeAlias(input.alias),
    hostName: normalizeToken(input.hostName, "SSH host name", 512),
    port: normalizePort(input.port),
    username: normalizeToken(input.username, "SSH username", 256),
    ...normalizeSshHostKey(input.hostKeyAlgorithm, input.hostKeyBase64),
  };
}

export function normalizeSshHostKeyText(value: string): NormalizedSshHostKey {
  const trimmed = bounded(value, "SSH public host key", 20_000).trim();
  const fields = trimmed.split(/\s+/u);
  if (fields.length < 2) {
    throw new Error(
      "SSH public host key must be a public-key line or one known_hosts line",
    );
  }
  const [algorithm, base64] = SUPPORTED_HOST_KEY_ALGORITHMS.has(fields[0]!)
    ? fields
    : fields.slice(1);
  if (
    algorithm === undefined
    || base64 === undefined
    || !SUPPORTED_HOST_KEY_ALGORITHMS.has(algorithm)
  ) {
    throw new Error(
      "SSH public host key must be a public-key line or one known_hosts line",
    );
  }
  return normalizeSshHostKey(algorithm, base64);
}

export function normalizeSshHostKey(
  algorithmValue: string,
  base64Value: string,
): NormalizedSshHostKey {
  const hostKeyAlgorithm = normalizeToken(
    algorithmValue,
    "SSH host-key algorithm",
    128,
  );
  if (!SUPPORTED_HOST_KEY_ALGORITHMS.has(hostKeyAlgorithm)) {
    throw new Error("SSH host-key algorithm is not supported");
  }
  const suppliedBase64 = normalizeToken(
    base64Value,
    "SSH host-key value",
    16 * 1024,
  );
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(suppliedBase64)) {
    throw new Error("SSH host-key value is not canonical base64");
  }
  const decoded = Buffer.from(suppliedBase64, "base64");
  const hostKeyBase64 = decoded.toString("base64");
  if (
    decoded.byteLength < 5
    || stripBase64Padding(hostKeyBase64) !== stripBase64Padding(suppliedBase64)
  ) {
    throw new Error("SSH host-key value is not canonical base64");
  }
  const encodedAlgorithmLength = decoded.readUInt32BE(0);
  if (
    encodedAlgorithmLength < 1
    || encodedAlgorithmLength > 128
    || 4 + encodedAlgorithmLength > decoded.byteLength
  ) {
    throw new Error("SSH host-key value has an invalid key blob");
  }
  const encodedAlgorithm = decoded.subarray(
    4,
    4 + encodedAlgorithmLength,
  ).toString("utf8");
  if (encodedAlgorithm !== hostKeyAlgorithm) {
    throw new Error("SSH host-key algorithm does not match the key blob");
  }
  return {
    hostKeyAlgorithm,
    hostKeyBase64,
    hostKeyFingerprint:
      `SHA256:${createHash("sha256").update(decoded).digest("base64").replace(/=+$/u, "")}`,
  };
}

export function toPublicSshTrustedHost(
  host: SecureSessionSshTrustedHost,
): SecureSshTrustedHostSummary {
  return {
    trustedHostId: host.trustedHostId,
    profileId: host.profileId,
    alias: host.alias,
    hostName: host.hostName,
    port: host.port,
    username: host.username,
    hostKeyAlgorithm: host.hostKeyAlgorithm,
    hostKeyFingerprint: host.hostKeyFingerprint,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
}

export function buildSecureSshConfig(
  hosts: readonly SecureSessionSshTrustedHost[],
): string {
  if (hosts.length === 0) return "";
  return `${hosts.map((host) => [
    `Host ${host.alias}`,
    `  HostName ${host.hostName}`,
    `  Port ${host.port}`,
    `  User ${host.username}`,
    `  HostKeyAlias ${host.alias}`,
    `  UserKnownHostsFile ${SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER}`,
    "  StrictHostKeyChecking yes",
    "  CheckHostIP no",
  ].join("\n")).join("\n\n")}\n`;
}

export function buildSecureSshKnownHosts(
  hosts: readonly SecureSessionSshTrustedHost[],
): string {
  const lines: string[] = [];
  for (const host of hosts) {
    lines.push(
      `${host.alias} ${host.hostKeyAlgorithm} ${host.hostKeyBase64}`,
    );
    if (host.port !== 22) {
      lines.push(
        `[${host.alias}]:${host.port} ${host.hostKeyAlgorithm} ${host.hostKeyBase64}`,
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function normalizeAlias(value: string): string {
  const alias = bounded(value, "SSH host alias", 128).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(alias)) {
    throw new Error(
      "SSH host alias may contain only letters, numbers, dots, dashes, and underscores",
    );
  }
  return alias;
}

function normalizeToken(value: string, label: string, maximum: number): string {
  const token = bounded(value, label, maximum).trim();
  if (
    token.startsWith("-")
    || /\s|[#"'\\%]|[\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return token;
}

function normalizePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("SSH port must be an integer between 1 and 65535");
  }
  return value;
}

function bounded(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maximum
    || value.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function stripBase64Padding(value: string): string {
  return value.replace(/=+$/u, "");
}

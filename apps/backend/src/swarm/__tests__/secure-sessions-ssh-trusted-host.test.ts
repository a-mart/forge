import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildSecureSshConfig,
  buildSecureSshKnownHosts,
  normalizeSshTrustedHostInput,
  SECURE_SSH_RESERVED_BINDING_PREFIX,
} from "../secure-sessions/ssh-trusted-host.js";
import {
  SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER,
} from "../secure-sessions/execution/secure-execution-backend.js";

function hostKey(algorithm = "ssh-ed25519"): string {
  const algorithmBytes = Buffer.from(algorithm, "utf8");
  const publicBytes = Buffer.alloc(32, 0x5a);
  const blob = Buffer.alloc(4 + algorithmBytes.length + 4 + publicBytes.length);
  blob.writeUInt32BE(algorithmBytes.length, 0);
  algorithmBytes.copy(blob, 4);
  blob.writeUInt32BE(publicBytes.length, 4 + algorithmBytes.length);
  publicBytes.copy(blob, 8 + algorithmBytes.length);
  return blob.toString("base64");
}

describe("SSH trusted-host validation and rendering", () => {
  it("normalizes a trusted host and renders strict execution-only SSH files", () => {
    const normalized = normalizeSshTrustedHostInput({
      alias: "production-api",
      hostName: "10.20.30.40",
      port: 2222,
      username: "deploy",
      hostKey: `ssh-ed25519 ${hostKey()} host-key-comment`,
    });
    const stored = {
      trustedHostId: "host-1",
      profileId: "profile-1",
      ...normalized,
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    };

    const config = buildSecureSshConfig([stored]);
    expect(config).toContain("Host production-api");
    expect(config).toContain("HostName 10.20.30.40");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain(
      `UserKnownHostsFile ${SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER}`,
    );
    expect(buildSecureSshKnownHosts([stored])).toContain(
      `[production-api]:2222 ssh-ed25519 ${normalized.hostKeyBase64}`,
    );
    expect(normalizeSshTrustedHostInput({
      alias: "production-api-copy",
      hostName: "10.20.30.41",
      username: "deploy",
      hostKey: `production-api ssh-ed25519 ${hostKey()}`,
    }).hostKeyBase64).toBe(normalized.hostKeyBase64);
    expect(SECURE_SSH_RESERVED_BINDING_PREFIX).toBe(
      "/run/forge-secure/bindings/.forge-ssh/",
    );
  });

  it("rejects key mismatches and OpenSSH configuration metacharacters", () => {
    expect(() => normalizeSshTrustedHostInput({
      alias: "production-api",
      hostName: "10.20.30.40",
      username: "deploy",
      hostKey: `ssh-rsa ${hostKey()}`,
    })).toThrow("does not match");

    for (const input of [
      { hostName: "server#ignored", username: "deploy" },
      { hostName: "server", username: "%h" },
      { hostName: "server", username: "domain\\deploy" },
    ]) {
      expect(() => normalizeSshTrustedHostInput({
        alias: "production-api",
        hostName: input.hostName,
        username: input.username,
        hostKey: `ssh-ed25519 ${hostKey()}`,
      })).toThrow("unsupported characters");
    }
  });
});

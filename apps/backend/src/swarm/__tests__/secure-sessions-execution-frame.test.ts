import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  encodeSecureExecutionFrame,
  secureExecutionFrameConstants,
  type SecureExecutionFrameHeader,
} from "../secure-sessions/execution/execution-frame.js";
import { SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER } from "../secure-sessions/execution/secure-execution-backend.js";
import { createExecutionDeliveryFromBindings } from "../secure-sessions/execution/protocol-binding-delivery.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";

function readHeader(frame: Buffer): SecureExecutionFrameHeader {
  const headerByteLength = frame.readUInt32BE(
    secureExecutionFrameConstants.magic.length,
  );
  return JSON.parse(
    frame
      .subarray(
        secureExecutionFrameConstants.prefixBytes,
        secureExecutionFrameConstants.prefixBytes + headerByteLength,
      )
      .toString("utf8"),
  ) as SecureExecutionFrameHeader;
}

function readMaterial(frame: Buffer): Buffer {
  const headerByteLength = frame.readUInt32BE(
    secureExecutionFrameConstants.magic.length,
  );
  return frame.subarray(
    secureExecutionFrameConstants.prefixBytes + headerByteLength,
  );
}

describe("secure execution frame", () => {
  it("keeps material out of the metadata header and preserves the exact command", () => {
    const environmentValue = Buffer.from("environment-canary");
    const fileValue = Buffer.from("file-canary");
    const askpassValue = Buffer.from("askpass-canary");
    const sshAgentValue = Buffer.from("ssh-agent-private-key-canary");
    const sshConfig = Buffer.from(
      `Host test\n  UserKnownHostsFile ${SECURE_SSH_KNOWN_HOSTS_PATH_PLACEHOLDER}\n`,
    );
    const knownHosts = Buffer.from("test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n");
    const stdinValue = Buffer.from("stdin-canary");
    const command = {
      executable: "/bin/sh",
      args: ["-lc", 'printf "%s" "$FORGE_TOKEN"'],
    };

    const frame = encodeSecureExecutionFrame({
      executionId: "0123456789abcdef01234567",
      command,
      workspacePath: "/workspace",
      delivery: {
        environment: [{ name: "FORGE_TOKEN", value: environmentValue }],
        ramFiles: [
          {
            targetPath: "/run/forge-secure/bindings/credentials/token",
            value: fileValue,
            pathEnvironmentVariable: "FORGE_TOKEN_FILE",
          },
        ],
        askpass: [
          {
            targetName: "SSH_ASKPASS",
            value: askpassValue,
          },
        ],
        sshAgent: [{ value: sshAgentValue }],
        sshTrust: {
          config: sshConfig,
          knownHosts,
        },
        stdin: stdinValue,
      },
    });

    const header = readHeader(frame);
    const headerText = JSON.stringify(header);
    expect(header.command).toEqual({
      executable: command.executable,
      args: command.args,
      cwd: "/workspace",
    });
    expect(header.environment).toEqual([
      { name: "FORGE_TOKEN", byteLength: environmentValue.byteLength },
    ]);
    expect(header.ramFiles).toEqual([
      {
        targetPath: "/run/forge-secure/bindings/credentials/token",
        fileMode: 0o400,
        byteLength: fileValue.byteLength,
        pathEnvironmentVariable: "FORGE_TOKEN_FILE",
      },
    ]);
    expect(header.stdinByteLength).toBe(stdinValue.byteLength);
    expect(header.askpass).toEqual([
      {
        targetName: "SSH_ASKPASS",
        index: 0,
        byteLength: askpassValue.byteLength,
      },
    ]);
    expect(header.sshAgent).toEqual([
      {
        index: 0,
        byteLength: sshAgentValue.byteLength,
      },
    ]);
    expect(header.sshTrust).toEqual({
      configByteLength: sshConfig.byteLength,
      knownHostsByteLength: knownHosts.byteLength,
    });
    expect(headerText).not.toContain(environmentValue.toString("utf8"));
    expect(headerText).not.toContain(fileValue.toString("utf8"));
    expect(headerText).not.toContain(stdinValue.toString("utf8"));
    expect(headerText).not.toContain(askpassValue.toString("utf8"));
    expect(headerText).not.toContain(sshAgentValue.toString("utf8"));
    expect(headerText).not.toContain(sshConfig.toString("utf8"));
    expect(headerText).not.toContain(knownHosts.toString("utf8"));

    frame.fill(0);
  });

  it("normalizes a recognized CRLF OpenSSH envelope at the host frame boundary", () => {
    const decoded = Buffer.concat([
      Buffer.from("openssh-key-v1\0", "ascii"),
      Buffer.from("synthetic-test-key-material-only", "utf8"),
    ]);
    const payload = decoded.toString("base64");
    decoded.fill(0);
    const sshAgentValue = Buffer.from([
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      payload,
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\r\n"), "utf8");
    const expected = Buffer.from(
      sshAgentValue.toString("utf8").replaceAll("\r\n", "\n"),
      "utf8",
    );

    const frame = encodeSecureExecutionFrame({
      executionId: "0123456789abcdef01234567",
      command: { executable: "true", args: [] },
      workspacePath: "/workspace",
      delivery: { sshAgent: [{ value: sshAgentValue }] },
    });
    try {
      expect(readHeader(frame).sshAgent).toEqual([{
        index: 0,
        byteLength: expected.byteLength,
      }]);
      expect(readMaterial(frame)).toEqual(expected);
      expect(sshAgentValue.includes(Buffer.from("\r\n", "utf8"))).toBe(true);
    } finally {
      sshAgentValue.fill(0);
      expected.fill(0);
      frame.fill(0);
    }
  });

  it("rejects ambiguous or escaping delivery metadata", () => {
    const base = {
      executionId: "0123456789abcdef01234567",
      command: { executable: "true", args: [] },
      workspacePath: "/workspace",
    };

    expect(() =>
      encodeSecureExecutionFrame({
        ...base,
        delivery: {
          environment: [
            { name: "TOKEN", value: Buffer.from("one") },
            { name: "TOKEN", value: Buffer.from("two") },
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_DELIVERY",
      }),
    );

    expect(() =>
      encodeSecureExecutionFrame({
        ...base,
        delivery: {
          ramFiles: [
            {
              targetPath: "/run/forge-secure/bindings/../outside",
              value: Buffer.from("value"),
            },
          ],
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_DELIVERY",
      }),
    );

    for (const name of ["BASH_ENV", "SSH_AUTH_SOCK"]) {
      expect(() =>
        encodeSecureExecutionFrame({
          ...base,
          delivery: {
            environment: [
              {
                name,
                value: Buffer.from("/tmp/untrusted-startup"),
              },
            ],
          },
        }),
      ).toThrowError(
        expect.objectContaining<Partial<SecureExecutionError>>({
          code: "INVALID_DELIVERY",
        }),
      );
    }
  });

  it("maps the landed public binding contract without weakening file modes", () => {
    const value = Buffer.from("resolved-value");
    const delivery = createExecutionDeliveryFromBindings([
      {
        binding: {
          deliveryKind: "environment",
          targetName: "FORGE_TOKEN",
        },
        value,
      },
      {
        binding: {
          deliveryKind: "file",
          targetPath: "/run/forge-secure/bindings/token",
          fileMode: 0o600,
        },
        value,
        pathEnvironmentVariable: "FORGE_TOKEN_FILE",
      },
      {
        binding: {
          deliveryKind: "askpass",
          targetName: "SSH_ASKPASS",
        },
        value,
      },
      {
        binding: { deliveryKind: "stdin" },
        value,
      },
      {
        binding: { deliveryKind: "ssh_agent" },
        value,
      },
    ]);

    expect(delivery).toEqual({
      environment: [{ name: "FORGE_TOKEN", value }],
      ramFiles: [
        {
          targetPath: "/run/forge-secure/bindings/token",
          value,
          fileMode: 0o600,
          pathEnvironmentVariable: "FORGE_TOKEN_FILE",
        },
      ],
      askpass: [{ targetName: "SSH_ASKPASS", value }],
      sshAgent: [{ value }],
      stdin: value,
    });
  });
});

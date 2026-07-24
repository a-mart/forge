import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  encodeSecureExecutionFrame,
  secureExecutionFrameConstants,
  type SecureExecutionFrameHeader,
} from "../secure-sessions/execution/execution-frame.js";
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

describe("secure execution frame", () => {
  it("keeps material out of the metadata header and preserves the exact command", () => {
    const environmentValue = Buffer.from("environment-canary");
    const fileValue = Buffer.from("file-canary");
    const askpassValue = Buffer.from("askpass-canary");
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
    expect(headerText).not.toContain(environmentValue.toString("utf8"));
    expect(headerText).not.toContain(fileValue.toString("utf8"));
    expect(headerText).not.toContain(stdinValue.toString("utf8"));
    expect(headerText).not.toContain(askpassValue.toString("utf8"));

    frame.fill(0);
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
      stdin: value,
    });

    expect(() =>
      createExecutionDeliveryFromBindings([
        {
          binding: { deliveryKind: "ssh_agent" },
          value,
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<SecureExecutionError>>({
        code: "INVALID_DELIVERY",
      }),
    );
  });
});

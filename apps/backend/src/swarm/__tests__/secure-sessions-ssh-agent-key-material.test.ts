import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { normalizeSshAgentKeyMaterial } from "../secure-sessions/execution/ssh-agent-key-material.js";

const OPENSSH_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END = "-----END OPENSSH PRIVATE KEY-----";

function syntheticOpenSshEnvelope(newline: "\n" | "\r\n" | "\r"): Buffer {
  const decoded = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    Buffer.from("synthetic-test-key-material-only", "utf8"),
  ]);
  try {
    const payload = decoded.toString("base64");
    return Buffer.from([
      OPENSSH_BEGIN,
      payload.slice(0, 32),
      payload.slice(32),
      OPENSSH_END,
      "",
    ].join(newline), "utf8");
  } finally {
    decoded.fill(0);
  }
}

function expectUnchanged(value: Buffer): void {
  const normalized = normalizeSshAgentKeyMaterial(value);
  try {
    expect(normalized).not.toBe(value);
    expect(normalized).toEqual(value);
  } finally {
    normalized.fill(0);
  }
}

describe("SSH-agent key material normalization", () => {
  it.each(["\r\n", "\r"] as const)(
    "normalizes %j only inside a recognized OpenSSH private-key envelope",
    (newline) => {
      const value = syntheticOpenSshEnvelope(newline);
      const normalized = normalizeSshAgentKeyMaterial(value);
      try {
        expect(normalized.toString("utf8")).toBe(
          syntheticOpenSshEnvelope("\n").toString("utf8"),
        );
        expect(value.includes(Buffer.from(newline, "utf8"))).toBe(true);
      } finally {
        value.fill(0);
        normalized.fill(0);
      }
    },
  );

  it("does not rewrite arbitrary, legacy, malformed, or non-UTF-8 material", () => {
    const nonOpenSsh = Buffer.from("arbitrary\r\nsecret\rmaterial", "utf8");
    const legacyPem = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\r\nc3ludGhldGlj\r\n-----END PRIVATE KEY-----\r\n",
      "utf8",
    );
    const malformedPayload = Buffer.from(
      `${OPENSSH_BEGIN}\r\nnot_base64\r\n${OPENSSH_END}\r\n`,
      "utf8",
    );
    const wrongPayload = Buffer.from(
      `${OPENSSH_BEGIN}\r\n${Buffer.from("not-an-openssh-key", "utf8").toString("base64")}\r\n${OPENSSH_END}\r\n`,
      "utf8",
    );
    const trailingContent = Buffer.concat([
      syntheticOpenSshEnvelope("\r\n"),
      Buffer.from("unexpected", "utf8"),
    ]);
    const invalidUtf8 = Buffer.from([0xff, 0x0d, 0x0a, 0xfe]);
    const values = [
      nonOpenSsh,
      legacyPem,
      malformedPayload,
      wrongPayload,
      trailingContent,
      invalidUtf8,
    ];

    try {
      for (const value of values) {
        expectUnchanged(value);
      }
    } finally {
      for (const value of values) value.fill(0);
    }
  });
});

import { Buffer } from "node:buffer";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SECURE_OUTPUT_QUARANTINE,
  SecureValueGuard,
  SecureValueGuardError,
} from "../secure-sessions/redaction/secure-value-guard.js";

const SELECTIVE_VALUE = Buffer.from("A9!xy_Z-42+/Qm", "utf8");
const MARKER = Buffer.from(SECURE_OUTPUT_QUARANTINE, "utf8");

function collect(
  guard: SecureValueGuard,
  chunks: readonly Uint8Array[],
): Buffer {
  const stream = guard.createStream();
  const output: Uint8Array[] = [];
  for (let index = 0; index < chunks.length - 1; index += 1) {
    output.push(stream.write(chunks[index] ?? Buffer.alloc(0)));
  }
  output.push(stream.end(chunks.at(-1) ?? Buffer.alloc(0)));
  return Buffer.concat(output.map((part) => Buffer.from(part)));
}

function twoChunks(input: Uint8Array, split: number): Uint8Array[] {
  return [input.subarray(0, split), input.subarray(split)];
}

function expectGuardError(
  operation: () => unknown,
  code: SecureValueGuardError["code"],
): void {
  try {
    operation();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SecureValueGuardError);
    expect((error as SecureValueGuardError).code).toBe(code);
  }
}

describe("SecureValueGuard byte streams", () => {
  it("round-trips safe opaque bytes exactly at every split point", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const safe = Buffer.from([
      0,
      255,
      1,
      ...Buffer.from("safe π 東京 payload", "utf8"),
      13,
      10,
    ]);

    for (let split = 0; split <= safe.byteLength; split += 1) {
      expect(collect(guard, twoChunks(safe, split))).toEqual(safe);
    }
  });

  it("detects a raw value at every split point without leaking its bytes", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const prefix = Buffer.from("visible-prefix:", "utf8");
    const input = Buffer.concat([
      prefix,
      SELECTIVE_VALUE,
      Buffer.from(":discarded-tail", "utf8"),
    ]);
    const expected = Buffer.concat([prefix, MARKER]);

    for (let split = 0; split <= input.byteLength; split += 1) {
      const output = collect(guard, twoChunks(input, split));
      expect(output).toEqual(expected);
      expect(output.includes(SELECTIVE_VALUE)).toBe(false);
    }
  });

  it("detects a UTF-8 value when every byte arrives separately", () => {
    const value = Buffer.from("π-A9!東京-x7_Z", "utf8");
    const guard = new SecureValueGuard([value]);
    const prefix = Buffer.from("prefix/", "utf8");
    const input = Buffer.concat([prefix, value, Buffer.from("/tail", "utf8")]);
    const chunks = [...input].map((byte) => Buffer.from([byte]));

    expect(collect(guard, chunks)).toEqual(Buffer.concat([prefix, MARKER]));
  });

  it("keeps simultaneous stream state independent", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const first = guard.createStream();
    const second = guard.createStream();
    const midpoint = Math.floor(SELECTIVE_VALUE.byteLength / 2);
    const firstOutput = [
      first.write(Buffer.concat([
        Buffer.from("one:", "utf8"),
        SELECTIVE_VALUE.subarray(0, midpoint),
      ])),
    ];
    const secondSafe = Buffer.concat([
      SELECTIVE_VALUE.subarray(midpoint),
      Buffer.from("|independent|", "utf8"),
      SELECTIVE_VALUE.subarray(0, midpoint),
    ]);
    const secondOutput = [
      second.write(secondSafe.subarray(0, 5)),
      second.end(secondSafe.subarray(5)),
    ];
    firstOutput.push(first.end(SELECTIVE_VALUE.subarray(midpoint)));

    expect(Buffer.concat(firstOutput.map(Buffer.from))).toEqual(
      Buffer.concat([Buffer.from("one:", "utf8"), MARKER]),
    );
    expect(Buffer.concat(secondOutput.map(Buffer.from))).toEqual(secondSafe);
  });

  it("isolates interleaved named output streams", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const guardOutput = guard.createOutputGuard<"stdout" | "stderr">();
    const midpoint = Math.floor(SELECTIVE_VALUE.byteLength / 2);
    const stdout = [
      guardOutput({
        stream: "stdout",
        bytes: SELECTIVE_VALUE.subarray(0, midpoint),
        final: false,
      }),
    ];
    const stderr = [
      guardOutput({
        stream: "stderr",
        bytes: Buffer.from("safe error", "utf8"),
        final: false,
      }),
      guardOutput({
        stream: "stderr",
        bytes: Buffer.alloc(0),
        final: true,
      }),
    ];
    stdout.push(
      guardOutput({
        stream: "stdout",
        bytes: SELECTIVE_VALUE.subarray(midpoint),
        final: true,
      }),
    );

    expect(Buffer.concat(stdout.map(Buffer.from))).toEqual(MARKER);
    expect(Buffer.concat(stderr.map(Buffer.from))).toEqual(
      Buffer.from("safe error", "utf8"),
    );
  });

  it("quarantines a value split across stdout and stderr in emission order", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const guardOutput = guard.createOutputGuard<"stdout" | "stderr">();
    const midpoint = Math.floor(SELECTIVE_VALUE.byteLength / 2);
    const output = [
      guardOutput({
        stream: "stdout",
        bytes: Buffer.concat([
          Buffer.from("safe/", "utf8"),
          SELECTIVE_VALUE.subarray(0, midpoint),
        ]),
        final: false,
      }),
      guardOutput({
        stream: "stderr",
        bytes: SELECTIVE_VALUE.subarray(midpoint),
        final: false,
      }),
      guardOutput({
        stream: "stdout",
        bytes: Buffer.alloc(0),
        final: true,
      }),
      guardOutput({
        stream: "stderr",
        bytes: Buffer.alloc(0),
        final: true,
      }),
    ];

    expect(Buffer.concat(output.map(Buffer.from))).toEqual(
      Buffer.concat([Buffer.from("safe/", "utf8"), MARKER]),
    );
  });

  it("quarantines a value split across final stdout and stderr chunks", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const guardOutput = guard.createOutputGuard<"stdout" | "stderr">();
    const midpoint = Math.floor(SELECTIVE_VALUE.byteLength / 2);
    const output = [
      guardOutput({
        stream: "stdout",
        bytes: SELECTIVE_VALUE.subarray(0, midpoint),
        final: true,
      }),
      guardOutput({
        stream: "stderr",
        bytes: SELECTIVE_VALUE.subarray(midpoint),
        final: true,
      }),
    ];

    expect(Buffer.concat(output.map(Buffer.from))).toEqual(MARKER);
  });

  it("deduplicates values and protects the longest overlapping prefix", () => {
    const long = Buffer.from("alpha-A9!middle-Z7@end", "utf8");
    const nested = Buffer.from("middle-Z7@", "utf8");
    const guard = new SecureValueGuard([nested, long, Buffer.from(long)]);
    const prefix = Buffer.from("safe/", "utf8");
    const input = Buffer.concat([prefix, long, Buffer.from("/tail", "utf8")]);

    for (let split = 0; split <= input.byteLength; split += 1) {
      expect(collect(guard, twoChunks(input, split))).toEqual(
        Buffer.concat([prefix, MARKER]),
      );
    }
  });

  it("finds a value after a cross-chunk KMP fallback", () => {
    const value = Buffer.from("ABABAC9!z_X7", "utf8");
    const guard = new SecureValueGuard([value]);
    const prefix = Buffer.from("safe/AB", "utf8");
    const input = Buffer.concat([
      Buffer.from("safe/ABABABAC9!z_X7", "utf8"),
      Buffer.from("/tail", "utf8"),
    ]);

    for (let split = 0; split <= input.byteLength; split += 1) {
      expect(collect(guard, twoChunks(input, split))).toEqual(
        Buffer.concat([prefix, MARKER]),
      );
    }
  });

  it("buffers low-entropy streams and quarantines only an exact match", () => {
    for (const value of [
      Buffer.from("x7!", "utf8"),
      Buffer.from("aaaaaaaaaaaaaaaa", "utf8"),
    ]) {
      const guard = new SecureValueGuard([value]);
      expect(collect(guard, [Buffer.from("entirely harmless", "utf8")])).toEqual(
        Buffer.from("entirely harmless", "utf8"),
      );
      expect(collect(guard, [Buffer.alloc(0)])).toEqual(Buffer.alloc(0));
      expect(guard.sanitizeString("harmless")).toBe("harmless");
      for (let split = 0; split <= value.byteLength; split += 1) {
        expect(collect(guard, twoChunks(value, split))).toEqual(MARKER);
      }
    }
  });

  it("releases harmless low-entropy streams at end and emits one marker on a match", () => {
    const guard = new SecureValueGuard([Buffer.from("111111111111", "utf8")]);
    const guardOutput = guard.createOutputGuard<"stdout" | "stderr">();
    const output = [
      guardOutput({
        stream: "stdout",
        bytes: Buffer.from("safe stdout", "utf8"),
        final: false,
      }),
      guardOutput({
        stream: "stderr",
        bytes: Buffer.from("safe stderr", "utf8"),
        final: false,
      }),
      guardOutput({ stream: "stdout", bytes: Buffer.alloc(0), final: true }),
      guardOutput({ stream: "stderr", bytes: Buffer.alloc(0), final: true }),
    ];

    expect(Buffer.concat(output.map(Buffer.from))).toEqual(
      Buffer.from("safe stdoutsafe stderr", "utf8"),
    );

    const matchingGuard = guard.createOutputGuard<"stdout" | "stderr">();
    const matching = [
      matchingGuard({
        stream: "stdout",
        bytes: Buffer.from("111111", "utf8"),
        final: false,
      }),
      matchingGuard({
        stream: "stdout",
        bytes: Buffer.from("111111", "utf8"),
        final: true,
      }),
      matchingGuard({
        stream: "stderr",
        bytes: Buffer.from("safe", "utf8"),
        final: true,
      }),
    ];
    expect(Buffer.concat(matching.map(Buffer.from))).toEqual(MARKER);
  });

  it("accepts NUL and invalid UTF-8 as exact raw byte values", () => {
    const nulValue = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251]);
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x80, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const value of [nulValue, invalidUtf8]) {
      const guard = new SecureValueGuard([value]);
      const prefix = Buffer.from("prefix", "utf8");
      expect(
        collect(guard, [...Buffer.concat([prefix, value])].map((byte) => Buffer.from([byte]))),
      ).toEqual(Buffer.concat([prefix, MARKER]));

      const encoded = Buffer.from(value.toString("base64"), "utf8");
      expect(collect(guard, [encoded])).toEqual(MARKER);
    }
  });

  it("preserves leading and trailing bytes instead of trimming registrations", () => {
    const exact = Buffer.from("  A9!Secret-Z7  ", "utf8");
    const guard = new SecureValueGuard([exact]);
    const trimmed = Buffer.from("A9!Secret-Z7", "utf8");

    expect(collect(guard, [trimmed])).toEqual(trimmed);
    expect(collect(guard, [exact])).toEqual(MARKER);
  });

  it("emits the quarantine marker once and bounds post-match output floods", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const stream = guard.createStream();
    const output = [
      stream.write(Buffer.concat([
        Buffer.from("safe/", "utf8"),
        SELECTIVE_VALUE,
        Buffer.alloc(64 * 1024, 120),
      ])),
    ];

    for (let index = 0; index < 512; index += 1) {
      output.push(stream.write(Buffer.alloc(64 * 1024, index % 251)));
    }
    output.push(stream.end());

    expect(Buffer.concat(output.map(Buffer.from))).toEqual(
      Buffer.concat([Buffer.from("safe/", "utf8"), MARKER]),
    );
  });

  it("rejects writes after finalization with a value-free code", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const stream = guard.createStream();
    stream.end(Buffer.from("safe", "utf8"));

    expectGuardError(
      () => stream.write(Buffer.from("another value", "utf8")),
      "SECURE_VALUE_STREAM_CLOSED",
    );
  });
});

describe("SecureValueGuard variants", () => {
  it("detects bounded standard encodings", () => {
    const text = 'A9!/"π?Z_x-42';
    const value = Buffer.from(text, "utf8");
    const guard = new SecureValueGuard([value]);
    const base64 = value.toString("base64");
    const base64Url = value.toString("base64url");
    const variants = new Set([
      base64,
      base64.replace(/=+$/u, ""),
      base64Url,
      base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "="),
      value.toString("hex"),
      value.toString("hex").toUpperCase(),
      encodeURIComponent(text),
      encodeURIComponent(text).replaceAll("%20", "+"),
      encodeURIComponent(text).replace(/%[0-9A-F]{2}/gu, (match) =>
        match.toLowerCase()),
      JSON.stringify(text).slice(1, -1),
      'A9!/\\"\\u03c0?Z_x-42',
    ]);

    for (const variant of variants) {
      const bytes = Buffer.from(variant, "utf8");
      for (let split = 0; split <= bytes.byteLength; split += 1) {
        expect(collect(guard, twoChunks(bytes, split))).toEqual(MARKER);
      }
    }
  });

  it("fails closed after the configured derived-byte budget is exhausted", () => {
    const value = Buffer.from("A9!xy_Z-42+/Qm", "utf8");
    expectGuardError(
      () => new SecureValueGuard([value], { maxDerivedBytes: 1 }),
      "SECURE_VALUE_REGISTRY_LIMIT",
    );
  });

  it("detects binary values through base64 and hex encodings", () => {
    const value = Buffer.from([0, 255, 1, 2, 128, 64, 32, 16]);
    const guard = new SecureValueGuard([value]);

    expect(collect(guard, [Buffer.from(value.toString("base64"))])).toEqual(
      MARKER,
    );
    expect(collect(guard, [Buffer.from(value.toString("hex"))])).toEqual(
      MARKER,
    );
  });

  it("detects common wrapped base64 output", () => {
    const value = Buffer.from("wrapped-redaction-value-".repeat(8), "utf8");
    const base64 = value.toString("base64");
    const wrapped = `${base64.match(/.{1,76}/gu)!.join("\n")}\n`;
    const guard = new SecureValueGuard([value]);

    expect(collect(guard, [Buffer.from(wrapped)])).toEqual(MARKER);
  });
});

describe("SecureValueGuard one-shot sanitization", () => {
  it("sanitizes recursive structures without mutating safe inputs", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const safeBuffer = Buffer.from("opaque-safe", "utf8");
    const input = {
      label: "safe",
      nested: ["also safe", { count: 3 }],
      bytes: safeBuffer,
    };

    const output = guard.sanitizeStructured(input);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect((output as typeof input).nested).not.toBe(input.nested);
    expect((output as typeof input).bytes).not.toBe(safeBuffer);
  });

  it("quarantines an entire structure for a value in a nested string or key", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    expect(
      guard.sanitizeStructured({
        safe: ["prefix", { nested: `before${SELECTIVE_VALUE.toString("utf8")}after` }],
      }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(
      guard.sanitizeStructured({
        [`key-${SELECTIVE_VALUE.toString("utf8")}`]: "safe",
      }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
  });

  it("quarantines numeric and boolean leaves that serialize to protected values", () => {
    expect(
      new SecureValueGuard(["731942"]).sanitizeStructured({ code: 731942 }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(
      new SecureValueGuard(["true"]).sanitizeStructured({ enabled: true }),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
  });

  it("quarantines matching byte containers, cycles, and accessors", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    expect(guard.sanitizeStructured({ bytes: Buffer.from(SELECTIVE_VALUE) })).toBe(
      SECURE_OUTPUT_QUARANTINE,
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(guard.sanitizeStructured(cyclic)).toBe(SECURE_OUTPUT_QUARANTINE);

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return SELECTIVE_VALUE.toString("utf8");
      },
    });
    expect(guard.sanitizeStructured(accessor)).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(getterCalls).toBe(0);
  });

  it("returns exact safe strings and constant whole-value quarantine markers", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const safe = "  safe π text  ";

    expect(guard.sanitizeString(safe)).toBe(safe);
    expect(
      guard.sanitizeString(`visible:${SELECTIVE_VALUE.toString("utf8")}:hidden`),
    ).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(guard.sanitizeBytes(Buffer.from(SELECTIVE_VALUE))).toEqual(MARKER);
  });
});

describe("SecureValueGuard registration and lifecycle policy", () => {
  it("rejects empty and over-cap values without including material in errors", () => {
    expectGuardError(
      () => new SecureValueGuard([Buffer.alloc(0)]),
      "SECURE_VALUE_EMPTY",
    );

    const overCap = Buffer.from("do-not-project-this-value", "utf8");
    try {
      new SecureValueGuard([overCap], { maxValueBytes: overCap.byteLength - 1 });
      throw new Error("Expected registration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SecureValueGuardError);
      expect((error as Error).message).toBe("SECURE_VALUE_TOO_LARGE");
      expect((error as Error).message).not.toContain(overCap.toString("utf8"));
      expect(inspect(error)).not.toContain(overCap.toString("utf8"));
    }
  });

  it("detects base64 values embedded after one- and two-byte prefixes", () => {
    const value = Buffer.from("embedded-A9!secret-x7_Z-value", "utf8");
    const guard = new SecureValueGuard([value]);
    for (const prefix of [Buffer.from("x"), Buffer.from("xy")]) {
      const encoded = Buffer.concat([prefix, value]).toString("base64");
      const output = collect(guard, [Buffer.from(encoded)]);
      expect(output.subarray(-MARKER.byteLength)).toEqual(MARKER);
      expect(output.toString("utf8")).not.toBe(encoded);
    }
  });

  it("enforces total registration and named-stream bounds", () => {
    expectGuardError(
      () =>
        new SecureValueGuard([SELECTIVE_VALUE, SELECTIVE_VALUE], {
          maxRegisteredBytes: SELECTIVE_VALUE.byteLength,
        }),
      "SECURE_VALUE_REGISTRY_LIMIT",
    );

    const guard = new SecureValueGuard([SELECTIVE_VALUE], { maxOutputStreams: 1 });
    const outputGuard = guard.createOutputGuard();
    outputGuard({ stream: "first", bytes: Buffer.alloc(0), final: false });
    expectGuardError(
      () => outputGuard({ stream: "second", bytes: Buffer.alloc(0), final: false }),
      "SECURE_VALUE_STREAM_LIMIT",
    );
  });

  it("blocks serialization and fails closed after disposal", () => {
    const guard = new SecureValueGuard([SELECTIVE_VALUE]);
    const stream = guard.createStream();

    expectGuardError(
      () => JSON.stringify(guard),
      "SECURE_VALUE_SERIALIZATION_BLOCKED",
    );
    expect(inspect(guard)).toBe("[SecureValueGuard]");
    expect(inspect(stream)).toBe("[SecureValueStreamGuard]");

    guard.dispose();
    expectGuardError(
      () => guard.sanitizeString("safe"),
      "SECURE_VALUE_GUARD_DISPOSED",
    );
    expectGuardError(
      () => stream.write(Buffer.from("safe", "utf8")),
      "SECURE_VALUE_STREAM_CLOSED",
    );
  });
});

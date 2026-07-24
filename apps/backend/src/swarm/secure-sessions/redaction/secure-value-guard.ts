import { Buffer } from "node:buffer";
import { inspect } from "node:util";

export const SECURE_OUTPUT_QUARANTINE = "[secret redacted by Forge]" as const;

const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_REGISTERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DERIVED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REGISTERED_VALUES = 256;
const DEFAULT_MAX_OUTPUT_STREAMS = 16;
const MIN_SELECTIVE_BYTES = 8;
const MIN_SELECTIVE_DISTINCT_BYTES = 4;
const MIN_SELECTIVE_ENTROPY_BITS_PER_BYTE = 2.5;
const MAX_VARIANTS_PER_VALUE = 32;
const MAX_STRUCTURED_DEPTH = 128;
const MAX_STRUCTURED_NODES = 100_000;
const MAX_BUFFERED_STREAM_BYTES = 16 * 1024 * 1024;
const EMPTY_BYTES = Buffer.alloc(0);
const QUARANTINE_BYTES = Buffer.from(SECURE_OUTPUT_QUARANTINE, "utf8");
const STRUCTURED_QUARANTINE = new Error("SECURE_STRUCTURED_OUTPUT_QUARANTINED");

/**
 * Stable default policy. Empty values are rejected because they match every
 * boundary. Every non-empty value within the configured hard caps is
 * protected. Values below the selective thresholds buffer each output stream
 * until completion so an exact match can quarantine the result without
 * revealing the match position; harmless output is then released unchanged.
 * NUL and invalid UTF-8 remain exact raw-byte patterns and receive byte-safe
 * Base64, Base64url, and hexadecimal variants.
 */
export const secureValueGuardPolicy = Object.freeze({
  defaultMaxValueBytes: DEFAULT_MAX_VALUE_BYTES,
  defaultMaxRegisteredBytes: DEFAULT_MAX_REGISTERED_BYTES,
  defaultMaxDerivedBytes: DEFAULT_MAX_DERIVED_BYTES,
  defaultMaxRegisteredValues: DEFAULT_MAX_REGISTERED_VALUES,
  defaultMaxOutputStreams: DEFAULT_MAX_OUTPUT_STREAMS,
  minSelectiveBytes: MIN_SELECTIVE_BYTES,
  minSelectiveDistinctBytes: MIN_SELECTIVE_DISTINCT_BYTES,
  minSelectiveEntropyBitsPerByte: MIN_SELECTIVE_ENTROPY_BITS_PER_BYTE,
  maxVariantsPerValue: MAX_VARIANTS_PER_VALUE,
});

export type SecureValue = string | Uint8Array;

export type SecureValueGuardErrorCode =
  | "SECURE_VALUE_EMPTY"
  | "SECURE_VALUE_TOO_LARGE"
  | "SECURE_VALUE_REGISTRY_LIMIT"
  | "SECURE_VALUE_GUARD_DISPOSED"
  | "SECURE_VALUE_STREAM_CLOSED"
  | "SECURE_VALUE_STREAM_LIMIT"
  | "SECURE_VALUE_SERIALIZATION_BLOCKED";

export class SecureValueGuardError extends Error {
  constructor(readonly code: SecureValueGuardErrorCode) {
    super(code);
    this.name = "SecureValueGuardError";
  }
}

export interface SecureValueGuardOptions {
  /**
   * A single value above this byte length is rejected before variants are built.
   * The default is 1 MiB.
   */
  maxValueBytes?: number;
  /**
   * Bounds copied raw registration material across all values.
   * The default is 8 MiB.
   */
  maxRegisteredBytes?: number;
  /**
   * Bounds encoded variants. Registration fails closed when this budget is
   * exhausted. The default is 16 MiB.
   */
  maxDerivedBytes?: number;
  /**
   * Bounds the number of caller-supplied values. The default is 256.
   */
  maxRegisteredValues?: number;
  /**
   * Bounds lazily-created streams in createOutputGuard(). The default is 16.
   */
  maxOutputStreams?: number;
}

export interface SecureOutputGuardInput<Stream extends string = string> {
  stream: Stream;
  bytes: Uint8Array;
  final: boolean;
}

export interface SecureOutputGuard<Stream extends string = string> {
  (input: SecureOutputGuardInput<Stream>): Uint8Array;
  didQuarantine(): boolean;
}

interface NormalizedOptions {
  maxValueBytes: number;
  maxRegisteredBytes: number;
  maxDerivedBytes: number;
  maxRegisteredValues: number;
  maxOutputStreams: number;
}

interface CompiledPattern {
  bytes: Buffer;
  prefixTable: Int32Array;
}

interface MatchProgress {
  matched: boolean;
  protectedLength: number;
  chunkOffset: number;
}

type StreamState = "open" | "quarantined" | "closed";

function requirePositiveInteger(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new SecureValueGuardError("SECURE_VALUE_REGISTRY_LIMIT");
  }
  return normalized;
}

function normalizeOptions(options: SecureValueGuardOptions): NormalizedOptions {
  return {
    maxValueBytes: requirePositiveInteger(options.maxValueBytes, DEFAULT_MAX_VALUE_BYTES),
    maxRegisteredBytes: requirePositiveInteger(
      options.maxRegisteredBytes,
      DEFAULT_MAX_REGISTERED_BYTES,
    ),
    maxDerivedBytes: requirePositiveInteger(
      options.maxDerivedBytes,
      DEFAULT_MAX_DERIVED_BYTES,
    ),
    maxRegisteredValues: requirePositiveInteger(
      options.maxRegisteredValues,
      DEFAULT_MAX_REGISTERED_VALUES,
    ),
    maxOutputStreams: requirePositiveInteger(
      options.maxOutputStreams,
      DEFAULT_MAX_OUTPUT_STREAMS,
    ),
  };
}

function copySecureValue(value: SecureValue): Buffer {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (!(value instanceof Uint8Array)) {
    throw new SecureValueGuardError("SECURE_VALUE_REGISTRY_LIMIT");
  }
  return Buffer.from(value);
}

function entropyBitsPerByte(bytes: Uint8Array): number {
  const counts = new Uint32Array(256);
  for (const byte of bytes) {
    counts[byte] += 1;
  }

  let entropy = 0;
  for (const count of counts) {
    if (count === 0) {
      continue;
    }
    const probability = count / bytes.byteLength;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSelectivelyMatchable(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MIN_SELECTIVE_BYTES) {
    return false;
  }

  const distinct = new Set(bytes).size;
  return (
    distinct >= MIN_SELECTIVE_DISTINCT_BYTES &&
    entropyBitsPerByte(bytes) >= MIN_SELECTIVE_ENTROPY_BITS_PER_BYTE
  );
}

function decodeTextVariant(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function pushUniqueBuffer(target: Buffer[], candidate: Buffer): boolean {
  if (target.some((existing) => existing.equals(candidate))) {
    candidate.fill(0);
    return false;
  }
  target.push(candidate);
  return true;
}

function encodedVariantBuffers(bytes: Buffer): Buffer[] {
  const variants: Buffer[] = [];
  const text = decodeTextVariant(bytes);

  const base64 = bytes.toString("base64");
  const base64Unpadded = base64.replace(/=+$/u, "");
  const base64Url = bytes.toString("base64url");
  const base64UrlPadded = base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const hex = bytes.toString("hex");

  const encoded = [
    base64,
    base64Unpadded,
    base64Url,
    base64UrlPadded,
    hex,
    hex.toUpperCase(),
    wrapBase64(base64, 64, "\n"),
    wrapBase64(base64, 64, "\r\n"),
    wrapBase64(base64, 76, "\n"),
    wrapBase64(base64, 76, "\r\n"),
  ];
  for (const shift of [1, 2]) {
    if (bytes.byteLength <= shift) continue;
    const shifted = bytes.subarray(shift);
    const shiftedBase64 = shifted.toString("base64");
    const shiftedBase64Url = shifted.toString("base64url");
    encoded.push(
      shiftedBase64,
      shiftedBase64.replace(/=+$/u, ""),
      shiftedBase64Url,
      shiftedBase64Url.padEnd(
        Math.ceil(shiftedBase64Url.length / 4) * 4,
        "=",
      ),
    );
  }

  if (text !== undefined) {
    const urlEncoded = encodeURIComponent(text);
    const lowerUrlEncoded = lowercasePercentEscapes(urlEncoded);
    const formEncoded = urlEncoded.replaceAll("%20", "+");
    const jsonEncoded = JSON.stringify(text).slice(1, -1);
    encoded.push(
      urlEncoded,
      lowerUrlEncoded,
      formEncoded,
      lowercasePercentEscapes(formEncoded),
      jsonEncoded,
      asciiJsonEscape(text, false),
      asciiJsonEscape(text, true),
    );
  }

  for (const value of encoded) {
    const candidate = Buffer.from(value, "utf8");
    if (!candidate.equals(bytes)) {
      pushUniqueBuffer(variants, candidate);
    } else {
      candidate.fill(0);
    }
  }
  return variants.slice(0, MAX_VARIANTS_PER_VALUE - 1);
}

function wrapBase64(
  value: string,
  width: number,
  newline: "\n" | "\r\n",
): string {
  if (value.length <= width) return value;
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return `${lines.join(newline)}${newline}`;
}

function lowercasePercentEscapes(value: string): string {
  return value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
}

function asciiJsonEscape(value: string, uppercaseHex: boolean): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0x80) {
      const hex = codeUnit.toString(16).padStart(4, "0");
      escaped += `\\u${uppercaseHex ? hex.toUpperCase() : hex}`;
      continue;
    }
    escaped += JSON.stringify(value[index]!).slice(1, -1);
  }
  return escaped;
}

function buildPrefixTable(pattern: Uint8Array): Int32Array {
  const table = new Int32Array(pattern.byteLength);
  let prefixLength = 0;
  for (let index = 1; index < pattern.byteLength; index += 1) {
    while (prefixLength > 0 && pattern[index] !== pattern[prefixLength]) {
      prefixLength = table[prefixLength - 1] ?? 0;
    }
    if (pattern[index] === pattern[prefixLength]) {
      prefixLength += 1;
    }
    table[index] = prefixLength;
  }
  return table;
}

function compilePatterns(patternBytes: Buffer[]): CompiledPattern[] {
  patternBytes.sort((left, right) => right.byteLength - left.byteLength);
  return patternBytes.map((bytes) => ({
    bytes,
    prefixTable: buildPrefixTable(bytes),
  }));
}

class PatternMatcher {
  private destroyed = false;
  private readonly starters: number[][];

  constructor(private readonly patterns: CompiledPattern[]) {
    this.starters = Array.from({ length: 256 }, () => []);
    for (let index = 0; index < patterns.length; index += 1) {
      const firstByte = patterns[index]?.bytes[0];
      if (firstByte !== undefined) {
        this.starters[firstByte]?.push(index);
      }
    }
  }

  createCursor(): PatternMatcherCursor {
    this.assertUsable();
    return new PatternMatcherCursor(this);
  }

  get patternCount(): number {
    return this.patterns.length;
  }

  patternAt(index: number): CompiledPattern {
    this.assertUsable();
    const pattern = this.patterns[index];
    if (!pattern) {
      throw new SecureValueGuardError("SECURE_VALUE_GUARD_DISPOSED");
    }
    return pattern;
  }

  patternsStartingWith(byte: number): readonly number[] {
    this.assertUsable();
    return this.starters[byte] ?? [];
  }

  assertUsable(): void {
    if (this.destroyed) {
      throw new SecureValueGuardError("SECURE_VALUE_GUARD_DISPOSED");
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const pattern of this.patterns) {
      pattern.bytes.fill(0);
      pattern.prefixTable.fill(0);
    }
    this.patterns.length = 0;
    for (const starters of this.starters) {
      starters.length = 0;
    }
  }
}

class PatternMatcherCursor {
  private readonly states: Int32Array;
  private readonly seenGeneration: Uint32Array;
  private activePatterns: number[] = [];
  private nextActivePatterns: number[] = [];
  private generation = 0;
  private protectedLength = 0;
  private disposed = false;

  constructor(private readonly matcher: PatternMatcher) {
    this.states = new Int32Array(matcher.patternCount);
    this.seenGeneration = new Uint32Array(matcher.patternCount);
  }

  consume(chunk: Uint8Array): MatchProgress {
    this.assertUsable();

    for (let chunkOffset = 0; chunkOffset < chunk.byteLength; chunkOffset += 1) {
      const byte = chunk[chunkOffset];
      let matched = false;
      let protectedLength = 0;
      this.advanceGeneration();
      this.nextActivePatterns.length = 0;

      // Patterns are compiled longest-first. If several overlapping or
      // duplicate-derived patterns complete on this byte, the longest state
      // therefore establishes the protected prefix.
      for (const patternIndex of this.activePatterns) {
        const pattern = this.matcher.patternAt(patternIndex);
        let state = this.states[patternIndex] ?? 0;

        while (state > 0 && pattern.bytes[state] !== byte) {
          state = pattern.prefixTable[state - 1] ?? 0;
        }
        if (pattern.bytes[state] === byte) {
          state += 1;
        }
        this.states[patternIndex] = state;
        this.seenGeneration[patternIndex] = this.generation;
        if (state > 0) {
          this.nextActivePatterns.push(patternIndex);
          protectedLength = Math.max(protectedLength, state);
          if (state === pattern.bytes.byteLength) {
            matched = true;
          }
        }
      }

      for (const patternIndex of this.matcher.patternsStartingWith(byte)) {
        if (this.seenGeneration[patternIndex] === this.generation) {
          continue;
        }
        const pattern = this.matcher.patternAt(patternIndex);
        this.states[patternIndex] = 1;
        this.nextActivePatterns.push(patternIndex);
        protectedLength = Math.max(protectedLength, 1);
        if (pattern.bytes.byteLength === 1) {
          matched = true;
        }
      }

      const previousActive = this.activePatterns;
      this.activePatterns = this.nextActivePatterns;
      this.nextActivePatterns = previousActive;
      this.protectedLength = protectedLength;
      if (matched) {
        return { matched: true, protectedLength, chunkOffset };
      }
    }

    return {
      matched: false,
      protectedLength: this.protectedLength,
      chunkOffset: chunk.byteLength,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.states.fill(0);
    this.seenGeneration.fill(0);
    this.activePatterns.length = 0;
    this.nextActivePatterns.length = 0;
  }

  private advanceGeneration(): void {
    this.generation = (this.generation + 1) >>> 0;
    if (this.generation === 0) {
      this.seenGeneration.fill(0);
      this.generation = 1;
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new SecureValueGuardError("SECURE_VALUE_STREAM_CLOSED");
    }
    this.matcher.assertUsable();
  }
}

function quarantineBytes(): Buffer {
  return Buffer.from(QUARANTINE_BYTES);
}

function containsRegisteredValue(matcher: PatternMatcher, bytes: Uint8Array): boolean {
  const cursor = matcher.createCursor();
  try {
    return cursor.consume(bytes).matched;
  } finally {
    cursor.dispose();
  }
}

export class SecureValueStreamGuard {
  private readonly cursor: PatternMatcherCursor;
  private pending = Buffer.alloc(0);
  private readonly buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private state: StreamState = "open";
  private markerEmitted = false;
  private quarantined = false;

  constructor(
    matcher: PatternMatcher,
    private readonly bufferUntilEnd: boolean,
    private readonly assertGuardUsable: () => void,
    private readonly onClose: () => void,
  ) {
    this.cursor = matcher.createCursor();
  }

  write(chunk: Uint8Array): Uint8Array {
    this.assertOpen();
    this.assertGuardUsable();
    if (!(chunk instanceof Uint8Array)) {
      return this.quarantine(EMPTY_BYTES);
    }
    if (this.bufferUntilEnd) {
      return this.writeBuffered(chunk);
    }
    return this.writeSelective(chunk);
  }

  end(chunk: Uint8Array = EMPTY_BYTES): Uint8Array {
    this.assertOpen();
    this.assertGuardUsable();
    if (!(chunk instanceof Uint8Array)) {
      const output = this.quarantine(EMPTY_BYTES);
      this.close();
      return output;
    }

    let output: Uint8Array;
    if (this.bufferUntilEnd) {
      output = this.writeBuffered(chunk);
      if (this.state === "open") {
        output = Buffer.concat(this.buffered);
        this.clearBuffered();
      }
    } else {
      output = this.writeSelective(chunk);
      if (this.state === "open") {
        const tail = Buffer.from(this.pending);
        this.pending.fill(0);
        this.pending = Buffer.alloc(0);
        output =
          output.byteLength === 0
            ? tail
            : Buffer.concat([Buffer.from(output), tail]);
      }
    }

    this.close();
    return output;
  }

  dispose(): void {
    if (this.state === "closed") {
      return;
    }
    this.close();
  }

  toJSON(): never {
    throw new SecureValueGuardError("SECURE_VALUE_SERIALIZATION_BLOCKED");
  }

  didQuarantine(): boolean {
    return this.quarantined;
  }

  [inspect.custom](): string {
    return "[SecureValueStreamGuard]";
  }

  private writeSelective(chunk: Uint8Array): Uint8Array {
    if (this.state === "quarantined") {
      return Buffer.alloc(0);
    }

    const owned = Buffer.from(chunk);
    try {
      const progress = this.cursor.consume(owned);

      const combined = Buffer.concat([this.pending, owned]);
      this.pending.fill(0);
      this.pending = Buffer.alloc(0);
      try {
        if (progress.matched) {
          const safeEnd =
            combined.byteLength -
            (owned.byteLength - progress.chunkOffset - 1) -
            progress.protectedLength;
          const safePrefix = Buffer.from(combined.subarray(0, Math.max(0, safeEnd)));
          return this.quarantine(safePrefix);
        }

        const safeEnd = combined.byteLength - progress.protectedLength;
        const safeOutput = Buffer.from(combined.subarray(0, safeEnd));
        this.pending = Buffer.from(combined.subarray(safeEnd));
        return safeOutput;
      } finally {
        combined.fill(0);
      }
    } finally {
      owned.fill(0);
    }
  }

  private writeBuffered(chunk: Uint8Array): Uint8Array {
    if (this.state === "quarantined" || chunk.byteLength === 0) {
      return Buffer.alloc(0);
    }
    if (this.bufferedBytes + chunk.byteLength > MAX_BUFFERED_STREAM_BYTES) {
      return this.quarantine(EMPTY_BYTES);
    }
    const owned = Buffer.from(chunk);
    this.buffered.push(owned);
    this.bufferedBytes += owned.byteLength;
    if (this.cursor.consume(owned).matched) {
      return this.quarantine(EMPTY_BYTES);
    }
    return Buffer.alloc(0);
  }

  private quarantine(prefix: Uint8Array): Uint8Array {
    this.quarantined = true;
    this.state = "quarantined";
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
    this.clearBuffered();
    this.cursor.dispose();

    if (this.markerEmitted) {
      return Buffer.alloc(0);
    }
    this.markerEmitted = true;
    return prefix.byteLength === 0
      ? quarantineBytes()
      : Buffer.concat([Buffer.from(prefix), QUARANTINE_BYTES]);
  }

  private assertOpen(): void {
    if (this.state === "closed") {
      throw new SecureValueGuardError("SECURE_VALUE_STREAM_CLOSED");
    }
  }

  private close(): void {
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
    this.clearBuffered();
    this.cursor.dispose();
    this.state = "closed";
    this.onClose();
  }

  private clearBuffered(): void {
    for (const chunk of this.buffered) chunk.fill(0);
    this.buffered.length = 0;
    this.bufferedBytes = 0;
  }
}

export class SecureValueGuard {
  private readonly matcher: PatternMatcher;
  private readonly bufferUntilEnd: boolean;
  private readonly options: NormalizedOptions;
  private readonly liveStreams = new Set<SecureValueStreamGuard>();
  private disposed = false;

  constructor(values: readonly SecureValue[], options: SecureValueGuardOptions = {}) {
    this.options = normalizeOptions(options);
    const registration = this.buildRegistration(values);
    this.bufferUntilEnd = registration.bufferUntilEnd;
    this.matcher = new PatternMatcher(compilePatterns(registration.patterns));
  }

  createStream(): SecureValueStreamGuard {
    this.assertUsable();
    const stream = new SecureValueStreamGuard(
      this.matcher,
      this.bufferUntilEnd,
      () => this.assertUsable(),
      () => this.liveStreams.delete(stream),
    );
    this.liveStreams.add(stream);
    return stream;
  }

  /**
   * Adapts the guard to interleaved named output such as stdout and stderr.
   * Each name receives isolated matcher state; a finalized name cannot restart.
   */
  createOutputGuard<Stream extends string>(): SecureOutputGuard<Stream> {
    this.assertUsable();
    const streams = new Map<Stream, SecureValueStreamGuard>();
    const combined = this.createStream();
    const finalized = new Set<Stream>();
    const finalizationOrder: Stream[] = [];
    let combinedQuarantined = false;
    let bufferedMarkerEmitted = false;
    let outputQuarantined = false;
    const outputGuard = (({ stream, bytes, final }) => {
      this.assertUsable();
      if (combinedQuarantined) {
        return Buffer.alloc(0);
      }
      if (finalized.has(stream)) {
        throw new SecureValueGuardError("SECURE_VALUE_STREAM_CLOSED");
      }

      if (bytes.byteLength > 0) combined.write(bytes);
      if (combined.didQuarantine()) {
        combinedQuarantined = true;
        outputQuarantined = true;
        combined.dispose();
        for (const existing of streams.values()) existing.dispose();
        streams.clear();
        return quarantineBytes();
      }

      let guarded = streams.get(stream);
      if (!guarded) {
        if (streams.size >= this.options.maxOutputStreams) {
          throw new SecureValueGuardError("SECURE_VALUE_STREAM_LIMIT");
        }
        guarded = this.createStream();
        streams.set(stream, guarded);
      }
      let output = guarded.write(bytes);
      if (guarded.didQuarantine()) outputQuarantined = true;
      if (final) {
        finalized.add(stream);
        finalizationOrder.push(stream);
        // Docker's secure execution contract has exactly these two streams.
        // Keep each stream's pending suffix private until both have finalized.
        // Otherwise a non-empty final chunk could release the first half of a
        // value before the combined matcher receives the second half.
        if (
          finalized.has("stdout" as Stream)
          && finalized.has("stderr" as Stream)
        ) {
          combined.end();
          if (combined.didQuarantine()) {
            combinedQuarantined = true;
            outputQuarantined = true;
            for (const existing of streams.values()) existing.dispose();
            streams.clear();
            return quarantineBytes();
          }
          const tails = finalizationOrder.map((name) => {
            const existing = streams.get(name);
            if (!existing) return Buffer.alloc(0);
            const tail = existing.end();
            if (existing.didQuarantine()) outputQuarantined = true;
            return tail;
          });
          output = Buffer.concat([Buffer.from(output), ...tails.map(Buffer.from)]);
        }
      }
      if (
        !this.bufferUntilEnd
        || output.byteLength === 0
        || !QUARANTINE_BYTES.equals(output)
      ) {
        return output;
      }
      if (bufferedMarkerEmitted) {
        return Buffer.alloc(0);
      }
      bufferedMarkerEmitted = true;
      return output;
    }) as SecureOutputGuard<Stream>;
    outputGuard.didQuarantine = () => outputQuarantined;
    return outputGuard;
  }

  /**
   * One-shot byte sanitization quarantines the whole value on a match. Safe
   * bytes are copied exactly and are never decoded or trimmed.
   */
  sanitizeBytes(bytes: Uint8Array): Uint8Array {
    this.assertUsable();
    if (!(bytes instanceof Uint8Array)) {
      return quarantineBytes();
    }
    if (containsRegisteredValue(this.matcher, bytes)) {
      return quarantineBytes();
    }
    return Buffer.from(bytes);
  }

  sanitizeString(value: string): string {
    this.assertUsable();
    return this.containsString(value) ? SECURE_OUTPUT_QUARANTINE : value;
  }

  /**
   * Recursively clones JSON-like data while examining strings, object keys,
   * and byte containers. A match, cycle, accessor, unsupported object, or
   * traversal-limit violation quarantines the entire structure with the same
   * constant marker, so callers receive no match location or variant metadata.
   */
  sanitizeStructured<T>(value: T): T | typeof SECURE_OUTPUT_QUARANTINE {
    this.assertUsable();
    const active = new WeakSet<object>();
    const clones = new WeakMap<object, unknown>();
    const budget = { nodes: 0 };
    try {
      return this.sanitizeStructuredNode(value, 0, budget, active, clones) as T;
    } catch {
      return SECURE_OUTPUT_QUARANTINE;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const stream of [...this.liveStreams]) {
      stream.dispose();
    }
    this.liveStreams.clear();
    this.matcher.destroy();
  }

  toJSON(): never {
    throw new SecureValueGuardError("SECURE_VALUE_SERIALIZATION_BLOCKED");
  }

  [inspect.custom](): string {
    return "[SecureValueGuard]";
  }

  private buildRegistration(values: readonly SecureValue[]): {
    patterns: Buffer[];
    bufferUntilEnd: boolean;
  } {
    if (values.length > this.options.maxRegisteredValues) {
      throw new SecureValueGuardError("SECURE_VALUE_REGISTRY_LIMIT");
    }

    const rawValues: Buffer[] = [];
    const patterns: Buffer[] = [];
    let rawBytes = 0;
    let bufferUntilEnd = false;
    try {
      for (const value of values) {
        const bytes = copySecureValue(value);
        if (bytes.byteLength === 0) {
          bytes.fill(0);
          throw new SecureValueGuardError("SECURE_VALUE_EMPTY");
        }
        if (bytes.byteLength > this.options.maxValueBytes) {
          bytes.fill(0);
          throw new SecureValueGuardError("SECURE_VALUE_TOO_LARGE");
        }
        rawBytes += bytes.byteLength;
        if (rawBytes > this.options.maxRegisteredBytes) {
          bytes.fill(0);
          throw new SecureValueGuardError("SECURE_VALUE_REGISTRY_LIMIT");
        }
        bufferUntilEnd ||= !isSelectivelyMatchable(bytes);
        rawValues.push(bytes);
      }

      let derivedBytes = 0;
      for (const raw of rawValues) {
        pushUniqueBuffer(patterns, Buffer.from(raw));
        const variants = encodedVariantBuffers(raw);
        for (const variant of variants) {
          if (derivedBytes + variant.byteLength > this.options.maxDerivedBytes) {
            variant.fill(0);
            throw new SecureValueGuardError("SECURE_VALUE_REGISTRY_LIMIT");
          }
          if (pushUniqueBuffer(patterns, variant)) {
            derivedBytes += variant.byteLength;
          }
        }
      }
      return { patterns, bufferUntilEnd };
    } catch (error) {
      for (const pattern of patterns) {
        pattern.fill(0);
      }
      throw error;
    } finally {
      for (const raw of rawValues) {
        raw.fill(0);
      }
    }
  }

  private sanitizeStructuredNode(
    value: unknown,
    depth: number,
    budget: { nodes: number },
    active: WeakSet<object>,
    clones: WeakMap<object, unknown>,
  ): unknown {
    budget.nodes += 1;
    if (depth > MAX_STRUCTURED_DEPTH || budget.nodes > MAX_STRUCTURED_NODES) {
      throw STRUCTURED_QUARANTINE;
    }

    if (typeof value === "string") {
      const bytes = Buffer.from(value, "utf8");
      try {
        if (containsRegisteredValue(this.matcher, bytes)) {
          throw STRUCTURED_QUARANTINE;
        }
        return value;
      } finally {
        bytes.fill(0);
      }
    }
    if (
      typeof value === "boolean"
      || typeof value === "number"
      || typeof value === "bigint"
    ) {
      const bytes = Buffer.from(String(value), "utf8");
      try {
        if (containsRegisteredValue(this.matcher, bytes)) {
          throw STRUCTURED_QUARANTINE;
        }
        return value;
      } finally {
        bytes.fill(0);
      }
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value !== "object") {
      throw STRUCTURED_QUARANTINE;
    }

    if (Buffer.isBuffer(value)) {
      if (containsRegisteredValue(this.matcher, value)) {
        throw STRUCTURED_QUARANTINE;
      }
      return Buffer.from(value);
    }
    if (value instanceof Uint8Array) {
      if (containsRegisteredValue(this.matcher, value)) {
        throw STRUCTURED_QUARANTINE;
      }
      return new Uint8Array(value);
    }
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value);
      if (containsRegisteredValue(this.matcher, bytes)) {
        throw STRUCTURED_QUARANTINE;
      }
      return bytes.slice().buffer;
    }

    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw STRUCTURED_QUARANTINE;
    }
    if (active.has(value)) {
      throw STRUCTURED_QUARANTINE;
    }
    const existing = clones.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const clone: unknown[] | Record<string, unknown> = Array.isArray(value)
      ? new Array(value.length)
      : Object.create(prototype) as Record<string, unknown>;
    clones.set(value, clone);
    active.add(value);
    try {
      for (const key of Object.keys(value)) {
        if (this.containsString(key)) {
          throw STRUCTURED_QUARANTINE;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw STRUCTURED_QUARANTINE;
        }
        const sanitized = this.sanitizeStructuredNode(
          descriptor.value,
          depth + 1,
          budget,
          active,
          clones,
        );
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: sanitized,
        });
      }
      return clone;
    } finally {
      active.delete(value);
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new SecureValueGuardError("SECURE_VALUE_GUARD_DISPOSED");
    }
  }

  private containsString(value: string): boolean {
    const bytes = Buffer.from(value, "utf8");
    try {
      return containsRegisteredValue(this.matcher, bytes);
    } finally {
      bytes.fill(0);
    }
  }
}

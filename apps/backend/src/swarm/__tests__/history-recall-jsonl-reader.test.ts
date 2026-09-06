import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alignToNextRecord, readCompleteLines, readTailLines } from "../history-recall/jsonl-reader.js";
import { MAX_LINE_BYTES } from "../history-recall/content-policy.js";
import { MAX_JSONL_CHUNK_BYTES } from "../history-recall/types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "history-reader-"));
  dirs.push(dir);
  const path = join(dir, "synthetic.jsonl");
  writeFileSync(path, text);
  return path;
}

describe("bounded JSONL forward progress", () => {
  it.each([MAX_LINE_BYTES - 1, MAX_LINE_BYTES, MAX_LINE_BYTES + 1, 4 * MAX_LINE_BYTES])(
    "handles a %i-byte row without stalling or reading beyond the budget plus one-byte probe", (size) => {
      const text = "x".repeat(size) + "\ntrailing\n";
      const path = fixture(text);
      let offset = 0;
      let skipping = false;
      const lines: string[] = [];
      for (let i = 0; i < 8 && offset < text.length; i++) {
        const scan = readCompleteLines(path, offset, text.length, MAX_LINE_BYTES, { resumeSkippingOversized: skipping });
        expect(scan.scannedBytes).toBeLessThanOrEqual(MAX_LINE_BYTES + 1);
        expect(scan.nextOffset).toBeGreaterThan(offset);
        offset = scan.nextOffset;
        skipping = scan.skippingOversized;
        lines.push(...scan.lines.map(line => line.line));
      }
      expect(offset).toBe(text.length);
      expect(lines).toEqual(size <= MAX_LINE_BYTES ? ["x".repeat(size), "trailing"] : ["trailing"]);
    },
  );

  it("completes a valid 500KiB row that exceeds a 256KiB batch without rereading from the row start", () => {
    const row = "x".repeat(500 * 1024);
    const text = `${row}\ntrailing\n`;
    const path = fixture(text);
    const budget = 256 * 1024;
    const first = readCompleteLines(path, 0, text.length, budget);
    expect(first.nextOffset).toBe(row.length + 1);
    expect(first.lines.map((line) => line.line)).toEqual([row]);
    expect(first.scannedBytes).toBeGreaterThan(budget);
    expect(first.scannedBytes).toBeLessThanOrEqual(row.length + MAX_JSONL_CHUNK_BYTES);
    const second = readCompleteLines(path, first.nextOffset, text.length, budget);
    expect(second.lines.map((line) => line.line)).toEqual(["trailing"]);
  });

  it("skips an oversized row across 256KiB batches and then reads the following evidence", () => {
    const text = `${"y".repeat(MAX_LINE_BYTES + 50_000)}\nafter-evidence\n`;
    const path = fixture(text);
    const budget = 256 * 1024;
    let offset = 0;
    let skipping = false;
    const lines: string[] = [];
    for (let i = 0; i < 8 && offset < text.length; i++) {
      const scan = readCompleteLines(path, offset, text.length, budget, { resumeSkippingOversized: skipping });
      expect(scan.nextOffset).toBeGreaterThan(offset);
      offset = scan.nextOffset;
      skipping = scan.skippingOversized;
      lines.push(...scan.lines.map((line) => line.line));
    }
    expect(offset).toBe(text.length);
    expect(lines).toEqual(["after-evidence"]);
  });

  it("resumes a mid-row oversized skip after a restart without stalling at the same frontier", () => {
    const text = `${"z".repeat(MAX_LINE_BYTES + 80_000)}\nresumed-evidence\n`;
    const path = fixture(text);
    const first = readCompleteLines(path, 0, text.length, 256 * 1024);
    expect(first.skippingOversized).toBe(true);
    expect(first.lines).toEqual([]);
    expect(first.nextOffset).toBeGreaterThan(0);
    const resumed = readCompleteLines(path, first.nextOffset, text.length, 256 * 1024, {
      resumeSkippingOversized: true,
    });
    expect(resumed.nextOffset).toBeGreaterThan(first.nextOffset);
    const lines = [...first.lines, ...resumed.lines].map((line) => line.line);
    if (!lines.includes("resumed-evidence")) {
      const rest = readCompleteLines(path, resumed.nextOffset, text.length, 256 * 1024, {
        resumeSkippingOversized: resumed.skippingOversized,
      });
      expect(rest.lines.map((line) => line.line)).toEqual(["resumed-evidence"]);
    } else {
      expect(lines).toContain("resumed-evidence");
    }
  });

  it("retries a smaller valid line at a budget boundary rather than discarding it", () => {
    const text = "first\n" + "x".repeat(MAX_LINE_BYTES - 2) + "\ntail\n";
    const path = fixture(text);
    const first = readCompleteLines(path, 0, text.length, MAX_LINE_BYTES);
    expect(first.nextOffset).toBe(6);
    const second = readCompleteLines(path, first.nextOffset, text.length, MAX_LINE_BYTES);
    expect(second.lines[0].line).toHaveLength(MAX_LINE_BYTES - 2);
    const third = readCompleteLines(path, second.nextOffset, text.length, MAX_LINE_BYTES);
    expect(third.lines.map(line => line.line)).toEqual(["tail"]);
  });

  it("aligns tail scans to the next newline instead of treating a mid-row seek as a record", () => {
    const text = "first\nsecond-record\nthird\n";
    const path = fixture(text);
    const midSecond = text.indexOf("second") + 3;
    expect(alignToNextRecord(path, midSecond, text.length)).toBe(text.indexOf("third"));
    const tail = readTailLines(path, text.length, 8);
    expect(tail.lines.map((line) => line.line)).toEqual(["third"]);
    expect(tail.startOffset).toBeGreaterThan(0);
  });

  it("resumes an oversized partial row after append without interpreting its suffix as a record", () => {
    const text = "x".repeat(MAX_LINE_BYTES + 1);
    const path = fixture(text);
    const scan = readCompleteLines(path, 0, text.length, MAX_LINE_BYTES);
    expect(scan.skippingOversized).toBe(true);
    const suffix = '{"not":"a new row"}\nactual\n';
    appendFileSync(path, suffix);
    const resumed = readCompleteLines(path, scan.nextOffset, text.length + suffix.length, MAX_LINE_BYTES, { resumeSkippingOversized: true });
    expect(resumed.lines.map(line => line.line)).toEqual(["actual"]);
    expect(resumed.skippingOversized).toBe(false);
  });
});

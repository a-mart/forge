import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCompleteLines } from "../history-recall/jsonl-reader.js";
import { MAX_LINE_BYTES } from "../history-recall/content-policy.js";

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

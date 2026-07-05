import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendJsonl,
  readJsonFileIfExists,
  updateJsonFileAtomic,
  writeFileAtomic,
  writeJsonFileAtomic,
} from "../atomic-files.js";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atomic-files-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic-files", () => {
  it("writeFileAtomic creates files and parent directories", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "nested", "dir", "note.txt");

    await writeFileAtomic(filePath, "hello world");

    await expect(readFile(filePath, "utf8")).resolves.toBe("hello world");
  });

  it("writeJsonFileAtomic pretty prints JSON with a trailing newline", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "data.json");

    await writeJsonFileAtomic(filePath, { answer: 42 });

    await expect(readFile(filePath, "utf8")).resolves.toBe(`{
  "answer": 42
}
`);
  });

  it("readJsonFileIfExists returns parsed data for existing files", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "config.json");

    await writeJsonFileAtomic(filePath, { enabled: true, count: 3 });

    await expect(readJsonFileIfExists<{ enabled: boolean; count: number }>(filePath)).resolves.toEqual({
      enabled: true,
      count: 3,
    });
  });

  it("readJsonFileIfExists returns undefined for missing files", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "missing.json");

    await expect(readJsonFileIfExists(filePath)).resolves.toBeUndefined();
  });

  it("readJsonFileIfExists returns undefined for malformed JSON", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "broken.json");

    await writeFileAtomic(filePath, "{not valid json");

    await expect(readJsonFileIfExists(filePath)).resolves.toBeUndefined();
  });

  it("updateJsonFileAtomic performs a read-modify-write cycle", async () => {
    const root = await createTempRoot();
    const filePath = join(root, "counter.json");

    const updated = await updateJsonFileAtomic(filePath, { count: 0 }, (current) => ({
      count: current.count + 1,
    }));

    expect(updated).toEqual({ count: 1 });
    await expect(readJsonFileIfExists<{ count: number }>(filePath)).resolves.toEqual({ count: 1 });
  });

  describe("writeFileAtomic crash window", () => {
    it("leaves a fresh target absent (not partially written) when rename fails permanently", async () => {
      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return {
          ...actual,
          rename: vi.fn().mockRejectedValue(Object.assign(new Error("simulated crash"), { code: "EPERM" })),
        };
      });

      const { writeFileAtomic: writeFileAtomicMocked } = await import("../atomic-files.js");
      const root = await createTempRoot();
      const filePath = join(root, "fresh.txt");

      await expect(writeFileAtomicMocked(filePath, "new content")).rejects.toThrow("simulated crash");

      // Target was never created — the crash happened between temp-write and rename.
      await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      // The temp file is left on disk holding the content that would have been renamed in.
      const entries = await readdir(root);
      const tempEntries = entries.filter((name) => name.startsWith("fresh.txt.") && name.endsWith(".tmp"));
      expect(tempEntries).toHaveLength(1);
      await expect(readFile(join(root, tempEntries[0]), "utf8")).resolves.toBe("new content");
    });

    it("leaves an existing target intact (not clobbered or truncated) when rename fails permanently", async () => {
      const root = await createTempRoot();
      const filePath = join(root, "existing.txt");
      await writeFileAtomic(filePath, "original content");

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return {
          ...actual,
          rename: vi.fn().mockRejectedValue(Object.assign(new Error("simulated crash"), { code: "EPERM" })),
        };
      });

      const { writeFileAtomic: writeFileAtomicMocked } = await import("../atomic-files.js");

      await expect(writeFileAtomicMocked(filePath, "replacement content")).rejects.toThrow("simulated crash");

      // The pre-existing target is untouched by the failed write — no torn/partial content.
      await expect(readFile(filePath, "utf8")).resolves.toBe("original content");

      // The replacement content sits only in a discardable temp file.
      const entries = await readdir(root);
      const tempEntries = entries.filter((name) => name.startsWith("existing.txt.") && name.endsWith(".tmp"));
      expect(tempEntries).toHaveLength(1);
      await expect(readFile(join(root, tempEntries[0]), "utf8")).resolves.toBe("replacement content");
    });
  });

  describe("appendJsonl", () => {
    it("creates parent directories and appends a single JSON line", async () => {
      const root = await createTempRoot();
      const filePath = join(root, "nested", "dir", "log.jsonl");

      await appendJsonl(filePath, { event: "started", seq: 1 });

      await expect(readFile(filePath, "utf8")).resolves.toBe('{"event":"started","seq":1}\n');
    });

    it("appends subsequent calls as additional lines without disturbing prior lines", async () => {
      const root = await createTempRoot();
      const filePath = join(root, "log.jsonl");

      await appendJsonl(filePath, { seq: 1 });
      await appendJsonl(filePath, { seq: 2 });
      await appendJsonl(filePath, { seq: 3 });

      const raw = await readFile(filePath, "utf8");
      const lines = raw.trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
      expect(lines).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    });
  });
});

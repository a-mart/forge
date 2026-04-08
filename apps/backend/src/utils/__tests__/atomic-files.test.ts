import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: readFileMock,
    writeFile: writeFileMock,
  };
});

import {
  FileBrowserService,
  MAX_EDITABLE_FILE_BYTES,
} from "../../services/file-browser-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileBrowserService.saveFileContent safeguards", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readFileMock.mockImplementation((path, encoding) => actual.readFile(path, encoding));
    writeFileMock.mockImplementation((path, data, encoding) => actual.writeFile(path, data, encoding));
  });

  it("returns too_large conflict before readFile for oversized current files", async () => {
    readFileMock.mockRejectedValue(new Error("readFile should not be called"));

    const root = await mkdtemp(join(tmpdir(), "file-browser-save-service-"));
    tempRoots.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const relativePath = "large-current.txt";
    const absolutePath = join(cwd, relativePath);
    const currentSize = MAX_EDITABLE_FILE_BYTES + 1;
    await writeFile(absolutePath, "x".repeat(currentSize), "utf8");

    const service = new FileBrowserService();
    const result = await service.saveFileContent({
      cwd,
      relativePath,
      content: "small\n",
      baseVersion: {
        kind: "sha256-stat-v1",
        sha256: "abc123",
        size: currentSize,
        mtimeMs: Date.now(),
      },
      overwrite: true,
    });

    expect(result).toMatchObject({
      success: false,
      conflict: true,
      reason: "too_large",
      currentSize,
    });
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

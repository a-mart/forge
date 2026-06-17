import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { FileBrowserService } from "../../services/file-browser-service.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: root });
}

describe("FileBrowserService.listDirectory", () => {
  it("includes gitignored files and directories in git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-browser-list-"));
    tempRoots.push(root);

    await initGitRepo(root);
    await writeFile(join(root, ".gitignore"), "ignored-dir/\nsecret.env\n", "utf8");
    await mkdir(join(root, "ignored-dir"), { recursive: true });
    await writeFile(join(root, "ignored-dir", "nested.txt"), "hidden\n", "utf8");
    await writeFile(join(root, "secret.env"), "TOKEN=abc\n", "utf8");
    await writeFile(join(root, "visible.txt"), "shown\n", "utf8");

    const service = new FileBrowserService();
    const result = await service.listDirectory(root, "");

    const entryNames = result.entries.map((entry) => entry.name);
    expect(entryNames).toContain("visible.txt");
    expect(entryNames).toContain("secret.env");
    expect(entryNames).toContain("ignored-dir");
    expect(entryNames).not.toContain(".git");
  });

  it("still excludes common noise directories outside git repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-browser-list-non-git-"));
    tempRoots.push(root);

    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n", "utf8");

    const service = new FileBrowserService();
    const result = await service.listDirectory(root, "");

    const entryNames = result.entries.map((entry) => entry.name);
    expect(entryNames).toContain("package.json");
    expect(entryNames).not.toContain("node_modules");
  });
});

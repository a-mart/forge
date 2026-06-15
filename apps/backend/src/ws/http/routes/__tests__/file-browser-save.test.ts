import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileContentResult, FileSaveResponse, FileVersionToken } from "@forge/protocol";
import { createWorktreeId } from "../../../../versioning/git-source-control-helpers.js";
import { createFileBrowserRoutes } from "../../../routes/file-browser-routes.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";
import {
  MAX_FILE_CONTENT_BYTES,
  MAX_FILE_SAVE_BODY_BYTES,
  MAX_FILE_SAVE_BYTES,
} from "../../services/file-browser-service.js";

const execFileAsync = promisify(execFile);

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file browser versioned save", () => {
  it("returns version, encoding, and editability metadata for small UTF-8 text files", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "hello.txt"), "hello\n", "utf8");

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("hello.txt")}`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as FileContentResult;
    expect(payload.content).toBe("hello\n");
    expect(payload.binary).toBe(false);
    expect(payload.encoding).toBe("utf8");
    expect(payload.version?.kind).toBe("sha256-stat-v1");
    expect(typeof payload.version?.sha256).toBe("string");
    expect(payload.editability).toEqual({
      editable: true,
      maxEditableBytes: 1 * 1024 * 1024,
    });
  });

  it("preserves leading and trailing whitespace in file paths for read and save", async () => {
    const harness = await createHarness();
    const leadingSpacePath = " foo.txt";
    const trailingSpacePath = "bar.txt ";
    await writeFile(join(harness.workspaceDir, leadingSpacePath), "leading-space\n", "utf8");
    await writeFile(join(harness.workspaceDir, "foo.txt"), "plain\n", "utf8");
    await writeFile(join(harness.workspaceDir, trailingSpacePath), "trailing-space\n", "utf8");
    await writeFile(join(harness.workspaceDir, "bar.txt"), "plain-bar\n", "utf8");

    const leadingRead = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(leadingSpacePath)}`,
    );
    expect(leadingRead.status).toBe(200);
    expect(((await leadingRead.json()) as FileContentResult).content).toBe("leading-space\n");

    const plainRead = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("foo.txt")}`,
    );
    expect(plainRead.status).toBe(200);
    expect(((await plainRead.json()) as FileContentResult).content).toBe("plain\n");

    const trailingRead = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(trailingSpacePath)}`,
    );
    expect(trailingRead.status).toBe(200);
    expect(((await trailingRead.json()) as FileContentResult).content).toBe("trailing-space\n");

    const trailingPlainRead = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("bar.txt")}`,
    );
    expect(trailingPlainRead.status).toBe(200);
    expect(((await trailingPlainRead.json()) as FileContentResult).content).toBe("plain-bar\n");

    const leadingVersion = ((await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(leadingSpacePath)}`,
    ).then((response) => response.json())) as FileContentResult).version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: leadingSpacePath,
        content: "leading-space-updated\n",
        baseVersion: leadingVersion,
      }),
    });
    expect(saveResponse.status).toBe(200);

    await expect(readFile(join(harness.workspaceDir, leadingSpacePath), "utf8")).resolves.toBe("leading-space-updated\n");
    await expect(readFile(join(harness.workspaceDir, "foo.txt"), "utf8")).resolves.toBe("plain\n");
  });

  it("returns binary editability metadata for binary files", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "data.bin"), Buffer.from([0, 1, 2, 0, 4]));

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("data.bin")}`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as FileContentResult;
    expect(payload.binary).toBe(true);
    expect(payload.content).toBeNull();
    expect(payload.editability).toEqual({
      editable: false,
      reason: "binary",
      maxEditableBytes: 1 * 1024 * 1024,
    });
  });

  it("marks previewable but non-editable files above the edit cap", async () => {
    const harness = await createHarness();
    const largeContent = "x".repeat(MAX_FILE_SAVE_BYTES + 1);
    await writeFile(join(harness.workspaceDir, "large.txt"), largeContent, "utf8");

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("large.txt")}`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as FileContentResult;
    expect(payload.content).toBe(largeContent);
    expect(payload.editability).toEqual({
      editable: false,
      reason: "too_large",
      maxEditableBytes: 1 * 1024 * 1024,
    });
  });

  it("rejects preview reads above the 2 MB cap", async () => {
    const harness = await createHarness();
    const tooLarge = "a".repeat(MAX_FILE_CONTENT_BYTES + 1);
    await writeFile(join(harness.workspaceDir, "too-large.txt"), tooLarge, "utf8");

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("too-large.txt")}`,
    );

    expect(response.status).toBe(413);
  });

  it("advertises GET, PUT, and OPTIONS on /api/files/content", async () => {
    const harness = await createHarness();

    const optionsResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, { method: "OPTIONS" });
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("access-control-allow-methods")).toContain("PUT");

    const postResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, { method: "POST" });
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toContain("PUT");
  });

  it("saves when baseVersion matches and returns a new version token", async () => {
    const harness = await createHarness();
    const filePath = "notes.txt";
    await writeFile(join(harness.workspaceDir, filePath), "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
    );
    const readPayload = (await readResponse.json()) as FileContentResult;
    const baseVersion = readPayload.version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: "updated\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    const savePayload = (await saveResponse.json()) as FileSaveResponse;
    expect(savePayload.success).toBe(true);
    if (savePayload.success) {
      expect(savePayload.version.sha256).not.toBe(baseVersion.sha256);
      expect(savePayload.lines).toBe(2);
      expect(savePayload.bytesWritten).toBe(Buffer.byteLength("updated\n", "utf8"));
    }

    await expect(readFile(join(harness.workspaceDir, filePath), "utf8")).resolves.toBe("updated\n");
  });

  it("rejects missing, null, malformed, or wrong-kind baseVersion with HTTP 400", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "a.txt"), "a\n", "utf8");

    const cases = [
      {},
      { baseVersion: null },
      { baseVersion: { kind: "wrong", sha256: "abc", size: 1, mtimeMs: 1 } },
      { baseVersion: { kind: "sha256-stat-v1", sha256: "", size: 1, mtimeMs: 1 } },
    ];

    for (const baseVersion of cases) {
      const response = await fetch(`${harness.server.baseUrl}/api/files/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "manager-1",
          path: "a.txt",
          content: "next\n",
          ...baseVersion,
        }),
      });

      expect(response.status).toBe(400);
    }

    const overwriteResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "a.txt",
        content: "next\n",
        overwrite: true,
      }),
    });
    expect(overwriteResponse.status).toBe(400);
  });

  it("rejects stale baseVersion with HTTP 409 and does not overwrite disk", async () => {
    const harness = await createHarness();
    const filePath = join(harness.workspaceDir, "stale.txt");
    await writeFile(filePath, "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("stale.txt")}`,
    );
    const readPayload = (await readResponse.json()) as FileContentResult;
    const baseVersion = readPayload.version!;

    await writeFile(filePath, "changed on disk\n", "utf8");

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "stale.txt",
        content: "stale draft\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(409);
    const conflict = (await saveResponse.json()) as FileSaveResponse;
    expect(conflict.success).toBe(false);
    if (!conflict.success) {
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toBe("modified");
      expect(conflict.currentVersion?.sha256).toBeDefined();
    }

    await expect(readFile(filePath, "utf8")).resolves.toBe("changed on disk\n");
  });

  it("allows overwrite only with a valid opened-file baseVersion for existing UTF-8 text files", async () => {
    const harness = await createHarness();
    const filePath = join(harness.workspaceDir, "overwrite.txt");
    await writeFile(filePath, "initial\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("overwrite.txt")}`,
    );
    const baseVersion = ((await readResponse.json()) as FileContentResult).version!;

    await writeFile(filePath, "changed on disk\n", "utf8");

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "overwrite.txt",
        content: "forced save\n",
        baseVersion,
        overwrite: true,
      }),
    });

    expect(saveResponse.status).toBe(200);
    await expect(readFile(filePath, "utf8")).resolves.toBe("forced save\n");
  });

  it("rejects overwrite for deleted, binary, and too-large targets", async () => {
    const harness = await createHarness();
    const baseVersion: FileVersionToken = {
      kind: "sha256-stat-v1",
      sha256: "abc123",
      size: 10,
      mtimeMs: Date.now(),
    };

    const deletedResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "missing.txt",
        content: "x\n",
        baseVersion,
        overwrite: true,
      }),
    });
    expect(deletedResponse.status).toBe(409);
    await expect(deletedResponse.json()).resolves.toMatchObject({ reason: "deleted" });

    await writeFile(join(harness.workspaceDir, "binary.bin"), Buffer.from([0, 1, 0]));
    const binaryResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "binary.bin",
        content: "x\n",
        baseVersion,
        overwrite: true,
      }),
    });
    expect(binaryResponse.status).toBe(409);
    await expect(binaryResponse.json()).resolves.toMatchObject({ reason: "binary" });

    const largeContent = "x".repeat(MAX_FILE_SAVE_BYTES + 1);
    await writeFile(join(harness.workspaceDir, "large.txt"), largeContent, "utf8");
    const largeResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "large.txt",
        content: "small\n",
        baseVersion,
        overwrite: true,
      }),
    });
    expect(largeResponse.status).toBe(409);
    await expect(largeResponse.json()).resolves.toMatchObject({
      reason: "too_large",
      currentSize: MAX_FILE_SAVE_BYTES + 1,
    });
  });

  it("returns 200 when getVersioningService throws after disk write", async () => {
    const harness = await createHarness();
    const filePath = "versioning-lookup-throw.txt";
    await writeFile(join(harness.workspaceDir, filePath), "initial\n", "utf8");
    const baseVersion = ((await (
      await fetch(
        `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
      )
    ).json()) as FileContentResult).version!;

    harness.swarmManager.getVersioningService = () => {
      throw new Error("versioning unavailable");
    };

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: "saved\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    await expect(readFile(join(harness.workspaceDir, filePath), "utf8")).resolves.toBe("saved\n");
  });

  it("returns 200 when isTrackedPath throws after disk write", async () => {
    const harness = await createHarness();
    const filePath = "versioning-tracked-throw.txt";
    await writeFile(join(harness.workspaceDir, filePath), "initial\n", "utf8");
    const baseVersion = ((await (
      await fetch(
        `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
      )
    ).json()) as FileContentResult).version!;

    harness.swarmManager.getVersioningService = () =>
      ({
        isTrackedPath: () => {
          throw new Error("isTrackedPath boom");
        },
        recordMutation: vi.fn(async () => true),
      }) as never;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: "saved\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    await expect(readFile(join(harness.workspaceDir, filePath), "utf8")).resolves.toBe("saved\n");
  });

  it("rejects traversal and symlink-to-outside save targets", async () => {
    const harness = await createHarness();
    const baseVersion: FileVersionToken = {
      kind: "sha256-stat-v1",
      sha256: "abc123",
      size: 10,
      mtimeMs: Date.now(),
    };

    const traversalResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "../secret.txt",
        content: "blocked\n",
        baseVersion,
      }),
    });
    expect(traversalResponse.status).toBe(403);

    const outsideDir = await mkdtemp(join(tmpdir(), "file-browser-save-outside-"));
    tempRoots.push(outsideDir);
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "secret\n", "utf8");
    const linkPath = join(harness.workspaceDir, "secret-link.txt");
    await symlink(outsideFile, linkPath, "file");

    const linkResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "secret-link.txt",
        content: "blocked\n",
        baseVersion,
      }),
    });
    expect(linkResponse.status).toBe(403);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("secret\n");
  });

  it("saves linked worktree files and rejects invalid worktree IDs", async () => {
    const harness = await createWorktreeHarness();
    const filePath = "linked-only.txt";
    await writeFile(join(harness.secondaryDir, filePath), "linked only\n", "utf8");

    const readResponse = await fetch(
      `${harness.server.baseUrl}/api/files/content?agentId=manager-1&worktreeId=${harness.secondaryWorktreeId}&path=${encodeURIComponent(filePath)}`,
    );
    const baseVersion = ((await readResponse.json()) as FileContentResult).version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        worktreeId: harness.secondaryWorktreeId,
        path: filePath,
        content: "linked updated\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    await expect(readFile(join(harness.secondaryDir, filePath), "utf8")).resolves.toBe("linked updated\n");

    const invalidResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        worktreeId: "deadbeefdeadbeef",
        path: filePath,
        content: "nope\n",
        baseVersion,
      }),
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("succeeds for untracked workspace files without embedded versioning", async () => {
    const harness = await createHarness();
    const recordMutation = vi.fn(async () => true);
    harness.swarmManager.getVersioningService = () =>
      ({
        isTrackedPath: () => false,
        recordMutation,
      }) as never;

    const filePath = "untracked.txt";
    await writeFile(join(harness.workspaceDir, filePath), "initial\n", "utf8");
    const baseVersion = ((await (
      await fetch(
        `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
      )
    ).json()) as FileContentResult).version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: "saved\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it("records versioning mutations only for tracked data-dir paths and remains fail-open", async () => {
    const harness = await createHarness();
    const recordMutation = vi.fn(async () => {
      throw new Error("versioning unavailable");
    });
    const trackedPath = join(harness.workspaceDir, "tracked.txt");
    await writeFile(trackedPath, "initial\n", "utf8");
    const trackedRealPath = await realpath(trackedPath);
    harness.swarmManager.getVersioningService = () =>
      ({
        isTrackedPath: (pathValue: string) => pathValue === trackedRealPath,
        recordMutation,
      }) as never;
    const baseVersion = ((await (
      await fetch(
        `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent("tracked.txt")}`,
      )
    ).json()) as FileContentResult).version!;

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "tracked.txt",
        content: "saved\n",
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
    expect(recordMutation).toHaveBeenCalledWith({
      path: trackedRealPath,
      action: "write",
      source: "api-write-file",
      agentId: "manager-1",
    });
  });

  it("returns 413 when the JSON body exceeds the transport cap", async () => {
    const harness = await createHarness();
    const oversizedBody = "x".repeat(MAX_FILE_SAVE_BODY_BYTES + 1);

    const response = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "a.txt",
        content: oversizedBody,
        baseVersion: {
          kind: "sha256-stat-v1",
          sha256: "abc",
          size: 1,
          mtimeMs: 1,
        },
      }),
    });

    expect(response.status).toBe(413);
  });

  it("accepts decoded content at the save cap even when JSON escaping expands the body", async () => {
    const harness = await createHarness();
    const filePath = "cap.txt";
    await writeFile(join(harness.workspaceDir, filePath), "seed\n", "utf8");
    const baseVersion = ((await (
      await fetch(
        `${harness.server.baseUrl}/api/files/content?agentId=manager-1&path=${encodeURIComponent(filePath)}`,
      )
    ).json()) as FileContentResult).version!;

    const exactCapContent = `"${"\\".repeat(MAX_FILE_SAVE_BYTES - 2)}"`;
    expect(Buffer.byteLength(exactCapContent, "utf8")).toBe(MAX_FILE_SAVE_BYTES);

    const saveResponse = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: filePath,
        content: exactCapContent,
        baseVersion,
      }),
    });

    expect(saveResponse.status).toBe(200);
  });

  it("returns deleted conflict semantics for missing files and does not create parent directories", async () => {
    const harness = await createHarness();
    const baseVersion: FileVersionToken = {
      kind: "sha256-stat-v1",
      sha256: "abc123",
      size: 10,
      mtimeMs: Date.now(),
    };

    const response = await fetch(`${harness.server.baseUrl}/api/files/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "manager-1",
        path: "nested/missing.txt",
        content: "new\n",
        baseVersion,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "deleted" });
  });
});

async function createHarness(): Promise<{
  workspaceDir: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-save-test-"));
  tempRoots.push(root);

  const workspaceDir = join(root, "workspace");
  const dataDir = join(root, "data");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(dataDir, "uploads"), { recursive: true });

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir,
        uploadsDir: join(dataDir, "uploads"),
      },
      cwdAllowlistRoots: [root],
    }),
    getAgent: (agentId: string) => {
      if (agentId === "manager-1") {
        return {
          agentId: "manager-1",
          role: "manager",
          cwd: workspaceDir,
        };
      }

      return undefined;
    },
    getVersioningService: () => undefined,
  };

  return {
    workspaceDir,
    swarmManager,
    server: await startRouteServer(swarmManager),
  };
}

async function createWorktreeHarness(): Promise<{
  secondaryDir: string;
  secondaryWorktreeId: string;
  swarmManager: any;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-save-worktree-"));
  tempRoots.push(root);

  const mainDir = join(root, "main");
  const secondaryDir = join(root, "linked");
  await mkdir(mainDir, { recursive: true });
  await writeFile(join(mainDir, "main-only.txt"), "main only\n", "utf8");
  await execGit(mainDir, ["init"]);
  await execGit(mainDir, ["config", "user.name", "Forge Test"]);
  await execGit(mainDir, ["config", "user.email", "forge-test@example.com"]);
  await execGit(mainDir, ["add", "main-only.txt"]);
  await execGit(mainDir, ["commit", "-m", "initial"]);
  await execGit(mainDir, ["branch", "feature/worktree-test"]);
  await execGit(mainDir, ["worktree", "add", secondaryDir, "feature/worktree-test"]);

  const mainRealPath = await realpath(mainDir);
  const secondaryRealPath = await realpath(secondaryDir);

  const swarmManager: any = {
    getConfig: () => ({
      paths: {
        rootDir: root,
        dataDir: join(root, "data"),
        uploadsDir: join(root, "data", "uploads"),
      },
      cwdAllowlistRoots: [root],
    }),
    getAgent: (agentId: string) => {
      if (agentId === "manager-1") {
        return {
          agentId: "manager-1",
          role: "manager",
          cwd: mainRealPath,
        };
      }

      return undefined;
    },
    getVersioningService: () => undefined,
  };

  return {
    secondaryDir: secondaryRealPath,
    secondaryWorktreeId: createWorktreeId(secondaryRealPath),
    swarmManager,
    server: await startRouteServer(swarmManager),
  };
}

async function startRouteServer(swarmManager: any): Promise<TestServer> {
  const routes = createFileBrowserRoutes({ swarmManager });
  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };

  activeServers.push(testServer);
  return testServer;
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

async function handleRouteRequest(
  routes: Array<{
    methods: string;
    matches: (pathname: string) => boolean;
    handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void>;
  }>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    applyCorsHeaders(request, response, route.methods);
    sendJson(response, 500, { error: message });
  }
}

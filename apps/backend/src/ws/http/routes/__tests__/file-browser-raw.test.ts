import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeId } from "../../../../versioning/git-source-control-helpers.js";
import { createFileBrowserRoutes, parseBytesRangeHeader } from "../../../routes/file-browser-routes.js";
import { applyCorsHeaders, sendJson } from "../../../http-utils.js";

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

describe("parseBytesRangeHeader", () => {
  it("parses open-ended and suffix ranges", () => {
    expect(parseBytesRangeHeader(undefined, 100)).toBeNull();
    expect(parseBytesRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseBytesRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseBytesRangeHeader("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
  });

  it("returns unsatisfiable for invalid ranges", () => {
    expect(parseBytesRangeHeader("bytes=100-50", 100)).toBe("unsatisfiable");
    expect(parseBytesRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseBytesRangeHeader("bytes=0-1", 0)).toBe("unsatisfiable");
    expect(parseBytesRangeHeader("invalid", 100)).toBe("unsatisfiable");
  });
});

describe("file browser raw route", () => {
  it("returns full PDF bytes and application/pdf content type", async () => {
    const harness = await createHarness();
    const pdfBytes = Buffer.from("%PDF-1.4\nsample-pdf-content\n%%EOF\n");
    await mkdir(join(harness.workspaceDir, "docs"), { recursive: true });
    await writeFile(join(harness.workspaceDir, "docs", "spec.pdf"), pdfBytes);

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("docs/spec.pdf")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-expose-headers")).toContain("Content-Range");
    await expect(response.arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
  });

  it("returns headers only for HEAD requests", async () => {
    const harness = await createHarness();
    const pdfBytes = Buffer.from("%PDF-1.4\nhead-only\n");
    await writeFile(join(harness.workspaceDir, "head.pdf"), pdfBytes);

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("head.pdf")}`,
      { method: "HEAD" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(pdfBytes.byteLength));
    await expect(response.arrayBuffer()).resolves.toEqual(new ArrayBuffer(0));
  });

  it("returns 206 with exact bytes and headers for valid ranges", async () => {
    const harness = await createHarness();
    const fileBytes = Buffer.from("0123456789abcdef");
    await writeFile(join(harness.workspaceDir, "range.bin"), fileBytes);

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("range.bin")}`,
      { headers: { Range: "bytes=3-7" } },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-range")).toBe("bytes 3-7/16");
    expect(response.headers.get("content-length")).toBe("5");
    await expect(response.arrayBuffer()).resolves.toEqual(fileBytes.subarray(3, 8).buffer);
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.workspaceDir, "small.pdf"), Buffer.from("%PDF-1.4\n"));

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("small.pdf")}`,
      { headers: { Range: "bytes=999-" } },
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */9");
  });

  it("returns 404 for unknown agents and missing files", async () => {
    const harness = await createHarness();

    const unknownAgentResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=missing-agent&path=${encodeURIComponent("missing.pdf")}`,
    );
    expect(unknownAgentResponse.status).toBe(404);

    const missingFileResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("missing.pdf")}`,
    );
    expect(missingFileResponse.status).toBe(404);
  });

  it("rejects traversal escapes and paths outside workspace", async () => {
    const harness = await createHarness();
    const outsideFile = join(harness.root, "outside.txt");
    await writeFile(outsideFile, "outside\n", "utf8");

    const traversalResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("../outside.txt")}`,
    );
    expect(traversalResponse.status).toBe(403);

    const outsideResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("../../outside.txt")}`,
    );
    expect(outsideResponse.status).toBe(403);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects symlink traversal outside workspace", async () => {
    const harness = await createHarness();
    const outsideDir = join(harness.root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.pdf"), Buffer.from("%PDF-secret"));
    await symlink(outsideDir, join(harness.workspaceDir, "escape-link"));

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("escape-link/secret.pdf")}`,
    );
    expect(response.status).toBe(403);
  });

  it("preserves leading and trailing whitespace in filenames", async () => {
    const harness = await createHarness();
    const spacedName = " report .pdf";
    const pdfBytes = Buffer.from("%PDF-1.4\nspaced-name\n");
    await writeFile(join(harness.workspaceDir, spacedName), pdfBytes);

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent(spacedName)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    await expect(response.arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
  });

  it("reads linked worktree PDFs without session cwd bleed-through", async () => {
    const harness = await createWorktreeHarness();
    const mainPdf = Buffer.from("%PDF-main");
    const linkedPdf = Buffer.from("%PDF-linked");
    await writeFile(join(harness.mainDir, "main.pdf"), mainPdf);
    await writeFile(join(harness.secondaryDir, "linked.pdf"), linkedPdf);

    const mainResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("main.pdf")}`,
    );
    expect(mainResponse.status).toBe(200);
    await expect(mainResponse.arrayBuffer()).resolves.toEqual(mainPdf.buffer);

    const linkedResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&worktreeId=${harness.secondaryWorktreeId}&path=${encodeURIComponent("linked.pdf")}`,
    );
    expect(linkedResponse.status).toBe(200);
    await expect(linkedResponse.arrayBuffer()).resolves.toEqual(linkedPdf.buffer);

    const wrongWorktreeResponse = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&worktreeId=${harness.secondaryWorktreeId}&path=${encodeURIComponent("main.pdf")}`,
    );
    expect(wrongWorktreeResponse.status).toBe(404);
  });

  it("allows in-workspace file symlinks", async () => {
    const harness = await createHarness();
    const targetPath = join(harness.workspaceDir, "target.pdf");
    const linkPath = join(harness.workspaceDir, "link.pdf");
    const pdfBytes = Buffer.from("%PDF-linked-target");
    await writeFile(targetPath, pdfBytes);
    await symlink(targetPath, linkPath);

    const response = await fetch(
      `${harness.server.baseUrl}/api/files/raw?agentId=manager-1&path=${encodeURIComponent("link.pdf")}`,
    );

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
    await expect(access(targetPath)).resolves.toBeUndefined();
  });
});

async function createHarness(): Promise<{
  root: string;
  workspaceDir: string;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-raw-test-"));
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
    root,
    workspaceDir,
    server: await startRouteServer(swarmManager),
  };
}

async function createWorktreeHarness(): Promise<{
  root: string;
  mainDir: string;
  secondaryDir: string;
  secondaryWorktreeId: string;
  server: TestServer;
}> {
  const root = await mkdtemp(join(tmpdir(), "file-browser-raw-worktree-test-"));
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
    root,
    mainDir: mainRealPath,
    secondaryDir: secondaryRealPath,
    secondaryWorktreeId: createWorktreeId(secondaryRealPath),
    server: await startRouteServer(swarmManager),
  };
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
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

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArtifactPreviewRoutes } from "../artifact-preview-routes.js";
import { getSessionFilePath } from "../../../../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../../../../swarm/session/conversation-timeline.js";
import {
  HtmlArtifactPreviewError,
  HtmlArtifactPreviewStore,
} from "../../../../swarm/session/html-artifact-preview.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const HTML = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><h1>Report</h1><img src="shots/a.png"><video src="media/clip.mp4"></video></body></html>`;

async function fixture() {
  const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir();
  const root = await mkdtemp(join(tempRoot, "artifact-preview-")); cleanup.push(root);
  const workspace = join(root, "workspace"); const report = join(workspace, "report");
  const dataDir = join(root, "data"); const uploadsDir = join(dataDir, "uploads");
  await mkdir(join(report, "shots"), { recursive: true }); await mkdir(join(report, "media"), { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(join(report, "index.html"), HTML);
  await writeFile(join(report, "style.css"), "h1{color:red}");
  await writeFile(join(report, "shots", "a.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await writeFile(join(report, "media", "clip.mp4"), Buffer.from("0123456789abcdef"));
  await writeFile(join(report, ".env"), "SECRET=1");
  await writeFile(join(report, "notes.ts"), "export const secret = 1");
  await writeFile(join(workspace, "secret.txt"), "outside the report folder");
  await symlink(join(workspace, "secret.txt"), join(report, "escape.txt"));

  const outside = await mkdtemp(join(tempRoot, "artifact-preview-outside-")); cleanup.push(outside);
  await writeFile(join(outside, "presented.html"), "<p>presented</p>");

  const profileId = "profile"; const agentId = "manager";
  const sessionFile = getSessionFilePath(dataDir, profileId, agentId);
  await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
  const presentedPath = process.platform === "darwin" ? join(outside, "presented.html").replace(/^\/private\/tmp\//, "/tmp/") : join(outside, "presented.html");
  await writeFile(sessionFile, JSON.stringify({
    type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m",
    data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[report](swarm-file://${presentedPath})`, timestamp: new Date().toISOString() },
  }) + "\n");

  const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: workspace };
  const swarmManager: any = {
    getAgent: (id: string) => id === agentId ? descriptor : undefined,
    listProfiles: () => [{ profileId }],
    getConfig: () => ({ paths: { rootDir: workspace, dataDir, uploadsDir }, cwdAllowlistRoots: [] }),
  };
  return { root, workspace, report, swarmManager, presentedPath, agentId };
}

async function serve(routes: ReturnType<typeof createArtifactPreviewRoutes>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const route = routes.find((r) => r.matches(url.pathname));
    if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function issue(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/artifact-previews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("HTML artifact preview route", () => {
  it("serves an authorized HTML file and its folder's web assets inside a no-network sandbox", async () => {
    const f = await fixture();
    const { server, base } = await serve(createArtifactPreviewRoutes({ swarmManager: f.swarmManager }));
    try {
      const issued = await issue(base, { path: join(f.report, "index.html"), agentId: f.agentId });
      expect(issued.status).toBe(200);
      const preview: any = await issued.json();
      expect(preview.url).toMatch(/^\/api\/artifact-previews\/[A-Za-z0-9_-]{32,}\/index\.html$/);
      expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());

      const page = await fetch(`${base}${preview.url}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await page.text()).toBe(HTML);
      const csp = page.headers.get("content-security-policy") ?? "";
      const scope = `${base}${preview.url.replace(/index\.html$/, "")}`;
      expect(csp).toContain("sandbox allow-scripts");
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain(`img-src ${scope} data: blob: https:`);
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      // Fonts and module scripts load in CORS mode from the sandbox's opaque origin.
      expect(page.headers.get("access-control-allow-origin")).toBe("*");
      expect(page.headers.get("access-control-allow-credentials")).toBeNull();

      const prefix = `${base}${preview.url.replace(/index\.html$/, "")}`;
      const css = await fetch(`${prefix}style.css`);
      expect(css.status).toBe(200); expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      const png = await fetch(`${prefix}shots/a.png`);
      expect(png.status).toBe(200); expect(png.headers.get("content-type")).toBe("image/png");

      const ranged = await fetch(`${prefix}media/clip.mp4`, { headers: { range: "bytes=4-7" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe("bytes 4-7/16");
      expect(ranged.headers.get("accept-ranges")).toBe("bytes");
      expect(await ranged.text()).toBe("4567");
      expect((await fetch(`${prefix}media/clip.mp4`, { headers: { range: "bytes=99-" } })).status).toBe(416);

      for (const denied of ["%2e%2e/secret.txt", "shots%2f..%2f..%2fsecret.txt", ".env", "notes.ts", "escape.txt", "missing.png", "shots//a.png"]) {
        const response = await fetch(`${prefix}${denied}`);
        expect([403, 404], denied).toContain(response.status);
        expect(await response.text(), denied).not.toMatch(/secret|SECRET|outside the report/);
      }
      expect((await fetch(`${base}/api/artifact-previews/${"x".repeat(43)}/index.html`)).status).toBe(404);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 15_000);

  it("authorizes previews only for readable HTML or a transcript-presented HTML file", async () => {
    const f = await fixture();
    const { server, base } = await serve(createArtifactPreviewRoutes({ swarmManager: f.swarmManager }));
    try {
      expect((await issue(base, { path: join(f.report, "style.css"), agentId: f.agentId })).status).toBe(400);
      expect((await issue(base, { path: f.presentedPath, agentId: f.agentId })).status).toBe(403);
      expect((await issue(base, { path: join(f.report, "nope.html"), agentId: f.agentId })).status).toBe(404);
      expect((await issue(base, {})).status).toBe(400);

      const presented = await issue(base, { transcriptAgentId: f.agentId, messageId: "m", path: f.presentedPath });
      expect(presented.status).toBe(200);
      const preview: any = await presented.json();
      const page = await fetch(`${base}${preview.url}`);
      expect(page.status).toBe(200); expect(await page.text()).toBe("<p>presented</p>");

      const notPresented = await issue(base, { transcriptAgentId: f.agentId, messageId: "m", path: join(f.report, "index.html") });
      expect(notPresented.status).toBe(403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 15_000);
});

describe("HtmlArtifactPreviewStore", () => {
  it("expires previews and never serves them to a different auth binding", async () => {
    const f = await fixture();
    let now = 1_000_000;
    const store = new HtmlArtifactPreviewStore({ now: () => now, ttlMs: 60_000 });
    const issued = await store.issue(join(f.report, "index.html"), "user-a");
    const token = issued.url.split("/")[3]!;

    await expect(store.resolveAsset(token, "index.html", "user-b")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.resolveAsset(token, "index.html", undefined)).rejects.toMatchObject({ code: "not_found" });
    expect((await store.resolveAsset(token, "index.html", "user-a")).contentType).toBe("text/html; charset=utf-8");
    // Multi-use until expiry: a page loads many assets.
    expect((await store.resolveAsset(token, "shots/a.png", "user-a")).contentType).toBe("image/png");

    now += 60_001;
    await expect(store.resolveAsset(token, "index.html", "user-a")).rejects.toBeInstanceOf(HtmlArtifactPreviewError);
    await expect(store.resolveAsset(token, "index.html", "user-a")).rejects.toMatchObject({ code: "not_found" });
  });

  it("bounds the number of live previews", async () => {
    const f = await fixture();
    const store = new HtmlArtifactPreviewStore({ maxPreviews: 2 });
    const first = await store.issue(join(f.report, "index.html"));
    await store.issue(join(f.report, "index.html"));
    await store.issue(join(f.report, "index.html"));
    await expect(store.resolveAsset(first.url.split("/")[3]!, "index.html")).rejects.toMatchObject({ code: "not_found" });
  });
});

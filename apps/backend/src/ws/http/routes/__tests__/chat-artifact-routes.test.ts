import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createChatArtifactRoutes } from "../chat-artifact-routes.js";
import { getSessionFilePath } from "../../../../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../../../../swarm/session/conversation-timeline.js";
import { MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES } from "../../../../swarm/session/presented-chat-artifact.js";
import { MAX_READ_FILE_CONTENT_BYTES } from "../../../ws-file-access.js";

const cleanup: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function execGit(cwd: string, args: string[]) { await execFileAsync("git", args, { cwd }); }

describe("chat artifact HTTP route", () => {
  it("reads an authorized image-shaped file and returns no-store typed denials", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const root = await mkdtemp(join(tempRoot, "artifact-route-")); cleanup.push(root);
    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const image = join(root, "outside.png"); const imageBytes = Buffer.alloc(MAX_READ_FILE_CONTENT_BYTES + 1); Buffer.from([137, 80, 78, 71]).copy(imageBytes); await writeFile(image, imageBytes);
    const presentedImage = process.platform === "darwin" ? image.replace(/^\/private\/tmp\//, "/tmp/") : image;
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[image](swarm-file://${presentedImage})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: root };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager, artifactSecurityPlatform: "win32" }); const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(r => r.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage }) });
      expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("no-store"); const payload: any = await ok.json(); expect(payload).toMatchObject({ path: presentedImage, binary: true, encoding: "base64", contentType: "image/png" }); expect(Buffer.from(payload.content, "base64")).toHaveLength(imageBytes.length);
      const injectedContext = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage, worktreeId: "caller-selected", sourceOwnerAgentId: "other" }) });
      expect(injectedContext.status).toBe(400); expect(await injectedContext.json()).toMatchObject({ code: "invalid_request" });
      await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES + 1));
      const oversized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage }) });
      expect(oversized.status).toBe(413); expect(await oversized.json()).toMatchObject({ code: "file_too_large" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: `${presentedImage}x` }) });
      expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("no-store"); expect(await denied.json()).toMatchObject({ code: "path_not_presented" });
      const outsideRoot = await mkdtemp(join(tempRoot, "artifact-route-outside-")); cleanup.push(outsideRoot); const outside = join(outsideRoot, "outside.txt"); await writeFile(outside, "outside");
      await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "outside", data: { type: "conversation_message", id: "outside", agentId, role: "assistant", source: "speak_to_user", text: `[outside](swarm-file://${outside})`, timestamp: new Date().toISOString() } }) + "\n");
      const outsideDenied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "outside", path: outside }) });
      expect(outsideDenied.status).toBe(403); expect(await outsideDenied.json()).toMatchObject({ code: "path_outside_workspace" });
      expect((await fetch(url, { method: "GET" })).status).toBe(405);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("returns the presented path for a Git-registered linked-worktree artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-route-worktree-")); cleanup.push(root);
    const main = join(root, "main"); const linked = join(root, "linked"); const unregistered = join(root, "main-lookalike");
    await mkdir(main); await mkdir(unregistered);
    await execGit(main, ["init"]); await execGit(main, ["config", "user.name", "Forge Test"]); await execGit(main, ["config", "user.email", "forge-test@example.com"]);
    await writeFile(join(main, "seed.txt"), "seed"); await execGit(main, ["add", "seed.txt"]); await execGit(main, ["commit", "-m", "initial"]);
    await execGit(main, ["branch", "linked-artifact"]); await execGit(main, ["worktree", "add", linked, "linked-artifact"]);
    const linkedTarget = join(await realpath(linked), "artifact.txt"); await writeFile(linkedTarget, "linked artifact");
    const deniedTarget = join(unregistered, "artifact.txt"); await writeFile(deniedTarget, "denied");

    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager";
    const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const entry = (id: string, target: string) => JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id, data: { type: "conversation_message", id, agentId, role: "assistant", source: "speak_to_user", text: `[artifact:${target}]`, timestamp: new Date().toISOString() } }) + "\n";
    await writeFile(sessionFile, entry("linked", linkedTarget) + entry("denied", deniedTarget));
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: await realpath(main) };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager });
    const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(candidate => candidate.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const allowed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "linked", path: linkedTarget }) });
      expect(allowed.status).toBe(200); expect(await allowed.json()).toMatchObject({ path: linkedTarget, content: "linked artifact" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "denied", path: deniedTarget }) });
      expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: "path_outside_workspace" });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

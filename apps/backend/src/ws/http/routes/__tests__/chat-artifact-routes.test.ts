import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatArtifactRoutes } from "../chat-artifact-routes.js";
import { getSessionFilePath } from "../../../../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../../../../swarm/session/conversation-timeline.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("chat artifact HTTP route", () => {
  it("reads an authorized image-shaped file and returns no-store typed denials", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const root = await mkdtemp(join(tempRoot, "artifact-route-")); cleanup.push(root);
    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const image = join(root, "outside.png"); await writeFile(image, Buffer.from([137, 80, 78, 71]));
    const presentedImage = process.platform === "darwin" ? image.replace(/^\/private\/tmp\//, "/tmp/") : image;
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[image](swarm-file://${presentedImage})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager }); const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(r => r.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage }) });
      expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("no-store"); expect(await ok.json()).toMatchObject({ binary: true, encoding: "base64", contentType: "image/png" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: `${presentedImage}x` }) });
      expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("no-store"); expect(await denied.json()).toMatchObject({ code: "path_not_presented" });
      expect((await fetch(url, { method: "GET" })).status).toBe(405);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsApiProxy } from "../ws/ws-api-proxy.js";
import { HtmlArtifactPreviewStore } from "../swarm/session/html-artifact-preview.js";
import { getSessionFilePath } from "../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../swarm/session/conversation-timeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("WS HTML artifact preview API proxy", () => {
  it("issues previews for readable or subscription-presented HTML and binds the owner to the subscription", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir();
    const root = await mkdtemp(join(tempRoot, "html-preview-ws-")); roots.push(root);
    const workspace = join(root, "workspace"); const dataDir = join(root, "data");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "report.html"), "<p>in workspace</p>");
    const outside = await mkdtemp(join(tempRoot, "html-preview-ws-outside-")); roots.push(outside);
    const presented = join(outside, "presented.html"); await writeFile(presented, "<p>presented</p>");

    const profileId = "profile"; const agentId = "manager";
    const sessionFile = getSessionFilePath(dataDir, profileId, agentId);
    await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[r](swarm-file://${presented})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: workspace };
    const swarmManager: any = {
      getAgent: (id: string) => id === agentId ? descriptor : undefined,
      listProfiles: () => [{ profileId }],
      getConfig: () => ({ paths: { rootDir: workspace, dataDir, uploadsDir: join(dataDir, "uploads") }, cwdAllowlistRoots: [] }),
    };
    const htmlPreviewStore = new HtmlArtifactPreviewStore();
    const proxy = new WsApiProxy({ swarmManager, mobilePushService: {}, feedbackService: {}, terminalService: null, unreadTracker: null, htmlPreviewStore } as any);
    const post = (body: unknown, requestId = "r") => proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/artifact-previews", body: JSON.stringify(body) } as any, agentId);

    const rooted = await post({ path: join(workspace, "report.html"), agentId });
    expect(rooted.status).toBe(200);
    const rootedUrl = JSON.parse(rooted.body).url as string;
    expect(rootedUrl).toMatch(/^\/api\/artifact-previews\/[A-Za-z0-9_-]+\/report\.html$/);
    // The same store backs the HTTP asset route.
    expect((await htmlPreviewStore.resolveAsset(rootedUrl.split("/")[3]!, "report.html")).size).toBeGreaterThan(0);

    expect((await post({ path: presented, agentId })).status).toBe(403);
    const viaPresentation = await post({ messageId: "m", path: presented });
    expect(viaPresentation.status).toBe(200);
    // The owner is the subscribed session; a caller-supplied owner cannot widen it.
    expect((await post({ messageId: "m", path: presented, transcriptAgentId: "someone-else" })).status).toBe(200);
    expect((await post({ messageId: "m", path: presented, worktreeId: "x" })).status).toBe(400);
    const method = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "g", method: "GET", path: "/api/artifact-previews", body: undefined } as any, agentId);
    expect(method.status).toBe(405);
  });
});

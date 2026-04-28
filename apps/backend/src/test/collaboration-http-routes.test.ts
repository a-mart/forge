import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateCollaborationBetterAuthService, clearCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { startServer, type StartedServer } from "../server.js";
import { createTempConfig, type TempConfigHandle } from "../test-support/temp-config.js";

const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "super-secret-password";
const MEMBER_EMAIL = "member@example.com";
const MEMBER_PASSWORD = "member-password-123";
const SILENT_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const tempConfigHandles: TempConfigHandle[] = [];
let activeServer: StartedServer | null = null;

afterEach(async () => {
  if (activeServer) {
    await activeServer.stop();
    activeServer = null;
  }

  while (tempConfigHandles.length > 0) {
    const handle = tempConfigHandles.pop();
    if (!handle) {
      continue;
    }
    clearCollaborationBetterAuthService(handle.config);
    closeCollaborationAuthDb(handle.config);
    await handle.cleanup();
  }
});

async function startCollaborationServer(): Promise<{
  server: StartedServer;
  config: TempConfigHandle["config"];
  baseUrl: string;
}> {
  const tempRootDir = await mkdtemp(join(tmpdir(), "forge-collaboration-http-routes-"));
  const tempConfigHandle = await createTempConfig({
    runtimeTarget: "collaboration-server",
    tempRootDir,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
  });
  tempConfigHandle.config.collaborationBaseUrl = `http://${tempConfigHandle.config.host}:${tempConfigHandle.config.port}`;
  tempConfigHandles.push(tempConfigHandle);

  const server = await startServer({
    config: tempConfigHandle.config,
    logger: SILENT_LOGGER,
  });
  activeServer = server;

  return {
    server,
    config: tempConfigHandle.config,
    baseUrl: `http://${server.host}:${server.port}`,
  };
}

describe("collaboration HTTP routes", () => {
  it("mounts Better Auth and gates admin routes behind collaboration auth", async () => {
    const { baseUrl } = await startCollaborationServer();

    const statusResponse = await fetch(`${baseUrl}/api/collaboration/status`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      enabled: true,
      adminExists: true,
      ready: true,
      bootstrapState: "ready",
      workspaceExists: true,
      workspaceDefaultsInitialized: true,
      storageProfileExists: true,
      storageRootSessionExists: true,
    });

    const meUnauthedResponse = await fetch(`${baseUrl}/api/collaboration/me`);
    expect(meUnauthedResponse.status).toBe(200);
    await expect(meUnauthedResponse.json()).resolves.toEqual({ authenticated: false });

    const adminRouteUnauthedResponse = await fetch(`${baseUrl}/api/settings/auth`);
    expect(adminRouteUnauthedResponse.status).toBe(401);
    await expect(adminRouteUnauthedResponse.json()).resolves.toEqual({ error: "Authentication required" });

    const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(loginResponse.ok).toBe(true);
    const adminCookieHeader = setCookieHeadersToCookieHeader(readSetCookieHeaders(loginResponse));
    expect(adminCookieHeader).toContain("forge_collab_session=");

    const meAuthedResponse = await fetch(`${baseUrl}/api/collaboration/me`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(meAuthedResponse.status).toBe(200);
    await expect(meAuthedResponse.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        email: ADMIN_EMAIL,
        role: "admin",
        disabled: false,
      },
    });

    const adminRouteAuthedResponse = await fetch(`${baseUrl}/api/settings/auth`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(adminRouteAuthedResponse.status).toBe(200);
  });

  it("supports users, invites, categories, channels, and prompt preview without AI roles", async () => {
    const { baseUrl, config } = await startCollaborationServer();

    const loginResponse = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(loginResponse.ok).toBe(true);
    const adminCookieHeader = setCookieHeadersToCookieHeader(readSetCookieHeaders(loginResponse));

    const createInviteResponse = await fetch(`${baseUrl}/api/collaboration/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({ email: MEMBER_EMAIL, expiresInDays: 14 }),
    });
    expect(createInviteResponse.status).toBe(200);
    const createInviteBody = await createInviteResponse.json() as {
      ok: true;
      invite: { inviteId: string; inviteUrl: string; email: string };
    };
    expect(createInviteBody.ok).toBe(true);
    expect(createInviteBody.invite.email).toBe(MEMBER_EMAIL);

    const invitesResponse = await fetch(`${baseUrl}/api/collaboration/invites`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(invitesResponse.status).toBe(200);
    await expect(invitesResponse.json()).resolves.toMatchObject({
      invites: [
        expect.objectContaining({ email: MEMBER_EMAIL, status: "pending" }),
      ],
    });

    const inviteToken = createInviteBody.invite.inviteUrl.split("/").at(-1);
    expect(inviteToken).toBeTruthy();

    const inviteLookupResponse = await fetch(`${baseUrl}/api/collaboration/invites/${inviteToken}`);
    expect(inviteLookupResponse.status).toBe(200);
    await expect(inviteLookupResponse.json()).resolves.toMatchObject({
      valid: true,
      invite: {
        email: MEMBER_EMAIL,
        inviteId: createInviteBody.invite.inviteId,
      },
    });

    const redeemResponse = await fetch(`${baseUrl}/api/collaboration/invites/${inviteToken}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: MEMBER_EMAIL,
        name: "Member",
        password: MEMBER_PASSWORD,
      }),
    });
    expect(redeemResponse.status).toBe(200);
    const redeemBody = await redeemResponse.json() as {
      ok: true;
      user: { userId: string; email: string; role: "member" };
    };
    expect(redeemBody.user.email).toBe(MEMBER_EMAIL);
    expect(redeemBody.user.role).toBe("member");

    const usersResponse = await fetch(`${baseUrl}/api/collaboration/users`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(usersResponse.status).toBe(200);
    await expect(usersResponse.json()).resolves.toMatchObject({
      users: expect.arrayContaining([
        expect.objectContaining({ email: ADMIN_EMAIL, role: "admin" }),
        expect.objectContaining({ email: MEMBER_EMAIL, role: "member" }),
      ]),
    });

    const updateUserResponse = await fetch(`${baseUrl}/api/collaboration/users/${encodeURIComponent(redeemBody.user.userId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({ name: "Renamed Member" }),
    });
    expect(updateUserResponse.status).toBe(200);
    await expect(updateUserResponse.json()).resolves.toMatchObject({
      ok: true,
      user: expect.objectContaining({ name: "Renamed Member" }),
    });

    const createCategoryResponse = await fetch(`${baseUrl}/api/collaboration/categories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        name: "Planning",
        defaultModelId: "pi-opus",
      }),
    });
    expect(createCategoryResponse.status).toBe(200);
    const createCategoryBody = await createCategoryResponse.json() as {
      ok: true;
      category: { categoryId: string; name: string; defaultModelId?: string };
    };
    expect(createCategoryBody.category.name).toBe("Planning");
    expect(createCategoryBody.category.defaultModelId).toBe("pi-opus");

    const categoriesUnauthedResponse = await fetch(`${baseUrl}/api/collaboration/categories`);
    expect(categoriesUnauthedResponse.status).toBe(401);
    await expect(categoriesUnauthedResponse.json()).resolves.toEqual({ error: "Authentication required" });

    const categoriesResponse = await fetch(`${baseUrl}/api/collaboration/categories`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(categoriesResponse.status).toBe(200);
    await expect(categoriesResponse.json()).resolves.toMatchObject({
      categories: [
        expect.objectContaining({
          categoryId: createCategoryBody.category.categoryId,
          name: "Planning",
          defaultModelId: "pi-opus",
        }),
      ],
    });

    const reorderCategoriesResponse = await fetch(`${baseUrl}/api/collaboration/categories/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({ categoryIds: [createCategoryBody.category.categoryId] }),
    });
    expect(reorderCategoriesResponse.status).toBe(200);
    await expect(reorderCategoriesResponse.json()).resolves.toMatchObject({
      ok: true,
      categories: [
        expect.objectContaining({ categoryId: createCategoryBody.category.categoryId }),
      ],
    });

    const createChannelResponse = await fetch(`${baseUrl}/api/collaboration/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        name: "General",
        categoryId: createCategoryBody.category.categoryId,
        description: "Primary room",
      }),
    });
    expect(createChannelResponse.status).toBe(200);
    const createChannelBody = await createChannelResponse.json() as {
      ok: true;
      channel: { channelId: string; sessionAgentId: string; modelId?: string; description?: string };
    };
    expect(createChannelBody.channel.description).toBe("Primary room");
    expect(createChannelBody.channel.modelId).toBe("pi-opus");

    const channelsUnauthedResponse = await fetch(`${baseUrl}/api/collaboration/channels`);
    expect(channelsUnauthedResponse.status).toBe(401);
    await expect(channelsUnauthedResponse.json()).resolves.toEqual({ error: "Authentication required" });

    const channelsResponse = await fetch(`${baseUrl}/api/collaboration/channels`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(channelsResponse.status).toBe(200);
    await expect(channelsResponse.json()).resolves.toMatchObject({
      channels: [
        expect.objectContaining({
          channelId: createChannelBody.channel.channelId,
          name: "General",
          modelId: "pi-opus",
        }),
      ],
    });

    const reorderChannelsResponse = await fetch(`${baseUrl}/api/collaboration/channels/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({ channelIds: [createChannelBody.channel.channelId] }),
    });
    expect(reorderChannelsResponse.status).toBe(200);
    await expect(reorderChannelsResponse.json()).resolves.toMatchObject({
      ok: true,
      channels: [
        expect.objectContaining({ channelId: createChannelBody.channel.channelId }),
      ],
    });

    const updateChannelResponse = await fetch(`${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        promptOverlay: "Prefer concise answers.",
      }),
    });
    expect(updateChannelResponse.status).toBe(200);
    await expect(updateChannelResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        promptOverlay: "Prefer concise answers.",
      }),
    });

    const adminChannelResponse = await fetch(`${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(adminChannelResponse.status).toBe(200);
    await expect(adminChannelResponse.json()).resolves.toMatchObject({
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        promptOverlay: "Prefer concise answers.",
      }),
    });

    const authService = await getOrCreateCollaborationBetterAuthService(config);
    const memberCookieHeader = setCookieHeadersToCookieHeader(
      await authService.createSessionCookies(redeemBody.user.userId),
    );

    const memberSettingsResponse = await fetch(`${baseUrl}/api/settings/auth`, {
      headers: { cookie: memberCookieHeader },
    });
    expect(memberSettingsResponse.status).toBe(403);
    await expect(memberSettingsResponse.json()).resolves.toEqual({ error: "Admin access required" });

    const memberChannelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
      { headers: { cookie: memberCookieHeader } },
    );
    expect(memberChannelResponse.status).toBe(200);
    const memberChannelBody = await memberChannelResponse.json() as {
      channel: { channelId: string; promptOverlay?: string };
    };
    expect(memberChannelBody.channel.channelId).toBe(createChannelBody.channel.channelId);
    expect(memberChannelBody.channel).not.toHaveProperty("promptOverlay");

    const promptPreviewResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/prompt-preview`,
      { headers: { cookie: memberCookieHeader } },
    );
    expect(promptPreviewResponse.status).toBe(200);
    const promptPreviewBody = await promptPreviewResponse.json() as {
      channelId: string;
      sections: Array<{ label: string; content: string }>;
      redacted: true;
    };
    expect(promptPreviewBody.channelId).toBe(createChannelBody.channel.channelId);
    expect(promptPreviewBody.redacted).toBe(true);
    expect(promptPreviewBody.sections.length).toBeGreaterThan(0);
    expect(promptPreviewBody.sections.some((section) => section.content.includes("Prefer concise answers."))).toBe(true);
    expect(promptPreviewBody.sections.every((section) => !section.content.includes(config.paths.dataDir))).toBe(true);

    const channelDetailUnauthedResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
    );
    expect(channelDetailUnauthedResponse.status).toBe(401);
    await expect(channelDetailUnauthedResponse.json()).resolves.toEqual({ error: "Authentication required" });
  });
});

function readSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies;
  }

  const joinedHeader = response.headers.get("set-cookie");
  return joinedHeader ? [joinedHeader] : [];
}

function setCookieHeadersToCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => {
      const firstSeparatorIndex = cookie.indexOf(";");
      return firstSeparatorIndex >= 0 ? cookie.slice(0, firstSeparatorIndex) : cookie;
    })
    .join("; ");
}

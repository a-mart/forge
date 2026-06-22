import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateCollaborationBetterAuthService, clearCollaborationBetterAuthService } from "../collaboration/auth/better-auth-service.js";
import { resolveModelDescriptorFromPreset } from "../swarm/model-presets.js";
import { closeCollaborationAuthDb } from "../collaboration/auth/collaboration-db.js";
import { createCollaborationDbHelpers } from "../collaboration/collab-db-helpers.js";
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
        defaultReasoningLevel: "low",
        defaultSkillSelection: {
          mode: "custom",
          savedSelectedSkillHandles: ["brave-search", "missing-skill"],
        },
      }),
    });
    expect(createCategoryResponse.status).toBe(200);
    const createCategoryBody = await createCategoryResponse.json() as {
      ok: true;
      category: {
        categoryId: string;
        name: string;
        defaultModelId?: string;
        defaultReasoningLevel?: string;
        channelCreationDefaults?: { model: { thinkingLevel: string } };
        defaultSkillSelection?: {
          mode: string;
          savedSelectedSkillHandles: string[];
          resolvedSkillHandles: string[];
          missingSkillHandles?: string[];
        };
      };
    };
    expect(createCategoryBody.category.name).toBe("Planning");
    expect(createCategoryBody.category.defaultModelId).toBe("pi-opus");
    expect(createCategoryBody.category.defaultReasoningLevel).toBe("low");
    expect(createCategoryBody.category.channelCreationDefaults?.model.thinkingLevel).toBe("low");
    expect(createCategoryBody.category.defaultSkillSelection).toMatchObject({
      mode: "custom",
      savedSelectedSkillHandles: ["brave-search", "missing-skill"],
      resolvedSkillHandles: ["brave-search"],
      alwaysOnSkillHandles: ["memory"],
      missingSkillHandles: ["missing-skill"],
    });

    const invalidCreateCategorySkillSelectionResponse = await fetch(`${baseUrl}/api/collaboration/categories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        name: "Invalid skill selection",
        defaultSkillSelection: { mode: "custom" },
      }),
    });
    expect(invalidCreateCategorySkillSelectionResponse.status).toBe(500);
    await expect(invalidCreateCategorySkillSelectionResponse.json()).resolves.toEqual({
      error: "defaultSkillSelection.savedSelectedSkillHandles must be an array when provided",
    });

    const missingDefaultsCategoryResponse = await fetch(`${baseUrl}/api/collaboration/categories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        name: "Missing defaults",
        defaultSelectedSpecialistHandles: ["missing-default-specialist"],
      }),
    });
    expect(missingDefaultsCategoryResponse.status).toBe(200);
    const missingDefaultsCategoryBody = await missingDefaultsCategoryResponse.json() as {
      ok: true;
      category: { categoryId: string; defaultSelectedSpecialistHandles: string[]; missingDefaultSpecialistHandles?: string[] };
    };
    expect(missingDefaultsCategoryBody).toMatchObject({
      ok: true,
      category: expect.objectContaining({
        defaultSelectedSpecialistHandles: ["missing-default-specialist"],
        missingDefaultSpecialistHandles: ["missing-default-specialist"],
      }),
    });

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
          defaultReasoningLevel: "low",
          channelCreationDefaults: expect.objectContaining({
            model: expect.objectContaining({ thinkingLevel: "low" }),
          }),
          defaultSkillSelection: expect.objectContaining({
            mode: "custom",
            savedSelectedSkillHandles: ["brave-search", "missing-skill"],
            missingSkillHandles: ["missing-skill"],
          }),
        }),
        expect.objectContaining({
          name: "Missing defaults",
          missingDefaultSpecialistHandles: ["missing-default-specialist"],
        }),
      ],
    });

    const invalidUpdateCategorySkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/categories/${encodeURIComponent(createCategoryBody.category.categoryId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ defaultSkillSelection: { mode: "selected", savedSelectedSkillHandles: [] } }),
      },
    );
    expect(invalidUpdateCategorySkillSelectionResponse.status).toBe(500);
    await expect(invalidUpdateCategorySkillSelectionResponse.json()).resolves.toEqual({
      error: "defaultSkillSelection.mode must be 'all' or 'custom'",
    });

    const resetCategorySkillDefaultsResponse = await fetch(
      `${baseUrl}/api/collaboration/categories/${encodeURIComponent(createCategoryBody.category.categoryId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ defaultSkillSelection: { mode: "all" } }),
      },
    );
    expect(resetCategorySkillDefaultsResponse.status).toBe(200);
    await expect(resetCategorySkillDefaultsResponse.json()).resolves.toMatchObject({
      ok: true,
      category: expect.objectContaining({
        defaultSkillSelection: expect.objectContaining({
          mode: "all",
          savedSelectedSkillHandles: [],
        }),
      }),
    });

    const restoreCategorySkillDefaultsResponse = await fetch(
      `${baseUrl}/api/collaboration/categories/${encodeURIComponent(createCategoryBody.category.categoryId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({
          defaultSkillSelection: {
            mode: "custom",
            savedSelectedSkillHandles: ["brave-search", "missing-skill"],
          },
        }),
      },
    );
    expect(restoreCategorySkillDefaultsResponse.status).toBe(200);

    const reorderCategoriesResponse = await fetch(`${baseUrl}/api/collaboration/categories/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        categoryIds: [createCategoryBody.category.categoryId, missingDefaultsCategoryBody.category.categoryId],
      }),
    });
    expect(reorderCategoriesResponse.status).toBe(200);
    await expect(reorderCategoriesResponse.json()).resolves.toMatchObject({
      ok: true,
      categories: [
        expect.objectContaining({ categoryId: createCategoryBody.category.categoryId }),
        expect.objectContaining({ categoryId: missingDefaultsCategoryBody.category.categoryId }),
      ],
    });

    const saveGlobalSpecialistResponse = await fetch(`${baseUrl}/api/settings/specialists/global-collab?targetSpace=collaboration`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify(createSpecialistBody({
        displayName: "Global Collab",
        whenToUse: "Use globally",
        promptBody: "Global collaboration prompt",
      })),
    });
    expect(saveGlobalSpecialistResponse.status).toBe(200);

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
        selectedGlobalSpecialistHandles: ["global-collab", "missing-selected-specialist"],
      }),
    });
    expect(createChannelResponse.status).toBe(200);
    const createChannelBody = await createChannelResponse.json() as {
      ok: true;
      channel: {
        channelId: string;
        sessionAgentId: string;
        modelId?: string;
        reasoningLevel?: string;
        description?: string;
        selectedGlobalSpecialistHandles: string[];
        activeSelectedSpecialistHandles: string[];
        missingSelectedSpecialistHandles?: string[];
        activeSkillSelection?: {
          mode: string;
          savedSelectedSkillHandles: string[];
          resolvedSkillHandles: string[];
          missingSkillHandles?: string[];
        };
      };
    };
    expect(createChannelBody.channel.description).toBe("Primary room");
    expect(createChannelBody.channel.selectedGlobalSpecialistHandles).toEqual(["global-collab", "missing-selected-specialist"]);
    expect(createChannelBody.channel.activeSelectedSpecialistHandles).toEqual(["global-collab", "missing-selected-specialist"]);
    expect(createChannelBody.channel.missingSelectedSpecialistHandles).toEqual(["missing-selected-specialist"]);
    expect(createChannelBody.channel.activeSkillSelection).toMatchObject({
      mode: "custom",
      savedSelectedSkillHandles: ["brave-search", "missing-skill"],
      resolvedSkillHandles: ["brave-search"],
      alwaysOnSkillHandles: ["memory"],
      missingSkillHandles: ["missing-skill"],
    });
    expect(createChannelBody.channel.modelId).toBe("pi-opus");
    expect(createChannelBody.channel.reasoningLevel).toBe("low");
    await expect(readStoredChannelModel(config.paths.agentsStoreFile, createChannelBody.channel.sessionAgentId)).resolves.toMatchObject({
      thinkingLevel: "low",
    });

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
          reasoningLevel: "low",
          selectedGlobalSpecialistHandles: ["global-collab", "missing-selected-specialist"],
          missingSelectedSpecialistHandles: ["missing-selected-specialist"],
          activeSkillSelection: expect.objectContaining({
            mode: "custom",
            savedSelectedSkillHandles: ["brave-search", "missing-skill"],
            missingSkillHandles: ["missing-skill"],
          }),
        }),
      ],
    });

    const authService = await getOrCreateCollaborationBetterAuthService(config);
    const memberCookieHeader = setCookieHeadersToCookieHeader(
      await authService.createSessionCookies(redeemBody.user.userId),
    );

    const memberSpecialistsResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists`,
      { headers: { cookie: memberCookieHeader } },
    );
    expect(memberSpecialistsResponse.status).toBe(403);
    await expect(memberSpecialistsResponse.json()).resolves.toEqual({ error: "Admin access required" });

    const memberRosterPromptResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists/roster-prompt`,
      { headers: { cookie: memberCookieHeader } },
    );
    expect(memberRosterPromptResponse.status).toBe(403);
    await expect(memberRosterPromptResponse.json()).resolves.toEqual({ error: "Admin access required" });

    const memberSkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/skills/selection`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: memberCookieHeader,
        },
        body: JSON.stringify({ mode: "all" }),
      },
    );
    expect(memberSkillSelectionResponse.status).toBe(403);
    await expect(memberSkillSelectionResponse.json()).resolves.toEqual({ error: "Admin access required" });

    const invalidSkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/skills/selection`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ activeSkillSelection: { mode: "custom", savedSelectedSkillHandles: ["agent-browser", ""] } }),
      },
    );
    expect(invalidSkillSelectionResponse.status).toBe(500);
    await expect(invalidSkillSelectionResponse.json()).resolves.toEqual({
      error: "activeSkillSelection.savedSelectedSkillHandles must contain only non-empty strings",
    });

    const updateSkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/skills/selection`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({
          activeSkillSelection: {
            mode: "custom",
            savedSelectedSkillHandles: ["agent-browser", "missing-skill-2"],
          },
        }),
      },
    );
    expect(updateSkillSelectionResponse.status).toBe(200);
    await expect(updateSkillSelectionResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        activeSkillSelection: expect.objectContaining({
          mode: "custom",
          savedSelectedSkillHandles: ["agent-browser", "missing-skill-2"],
          resolvedSkillHandles: ["agent-browser"],
          alwaysOnSkillHandles: ["memory"],
          missingSkillHandles: ["missing-skill-2"],
        }),
      }),
    });

    const resetSkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/skills/selection`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ mode: "all" }),
      },
    );
    expect(resetSkillSelectionResponse.status).toBe(200);
    await expect(resetSkillSelectionResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        activeSkillSelection: expect.objectContaining({
          mode: "all",
          savedSelectedSkillHandles: [],
          alwaysOnSkillHandles: ["memory"],
        }),
      }),
    });

    const patchSkillSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({
          activeSkillSelection: {
            mode: "custom",
            savedSelectedSkillHandles: ["brave-search", "missing-skill"],
          },
        }),
      },
    );
    expect(patchSkillSelectionResponse.status).toBe(200);
    await expect(patchSkillSelectionResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        activeSkillSelection: expect.objectContaining({
          mode: "custom",
          savedSelectedSkillHandles: ["brave-search", "missing-skill"],
        }),
      }),
    });

    const saveChannelSpecialistResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists/global-collab`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify(createSpecialistBody({
          displayName: "Local Collab",
          whenToUse: "Use locally",
          promptBody: "Local collaboration prompt",
        })),
      },
    );
    expect(saveChannelSpecialistResponse.status).toBe(200);

    const channelSpecialistsResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists`,
      { headers: { cookie: adminCookieHeader } },
    );
    expect(channelSpecialistsResponse.status).toBe(200);
    await expect(channelSpecialistsResponse.json()).resolves.toMatchObject({
      channelId: createChannelBody.channel.channelId,
      selectedGlobalSpecialistHandles: ["global-collab", "missing-selected-specialist"],
      missingSelectedSpecialistHandles: ["missing-selected-specialist"],
      specialists: [
        expect.objectContaining({
          specialistId: "global-collab",
          displayName: "Local Collab",
          sourceKind: "channel",
          shadowsGlobal: true,
          promptBody: "Local collaboration prompt",
        }),
      ],
    });

    const rosterPromptResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists/roster-prompt`,
      { headers: { cookie: adminCookieHeader } },
    );
    expect(rosterPromptResponse.status).toBe(200);
    const rosterPromptBody = await rosterPromptResponse.json() as { markdown: string };
    expect(rosterPromptBody.markdown).toContain("Use locally");

    const updateSelectionResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists/selection`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ selectedGlobalSpecialistHandles: ["global-collab"] }),
      },
    );
    expect(updateSelectionResponse.status).toBe(200);
    await expect(updateSelectionResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        selectedGlobalSpecialistHandles: ["global-collab"],
        activeSelectedSpecialistHandles: ["global-collab"],
      }),
    });

    const deleteChannelSpecialistResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists/global-collab`,
      {
        method: "DELETE",
        headers: { cookie: adminCookieHeader },
      },
    );
    expect(deleteChannelSpecialistResponse.status).toBe(200);

    const channelSpecialistsAfterDeleteResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/specialists`,
      { headers: { cookie: adminCookieHeader } },
    );
    expect(channelSpecialistsAfterDeleteResponse.status).toBe(200);
    await expect(channelSpecialistsAfterDeleteResponse.json()).resolves.toMatchObject({
      specialists: [
        expect.objectContaining({
          specialistId: "global-collab",
          displayName: "Global Collab",
          sourceKind: "global",
          promptBody: "Global collaboration prompt",
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

    const updateChannelReasoningResponse = await fetch(`${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        reasoningLevel: "high",
      }),
    });
    expect(updateChannelReasoningResponse.status).toBe(200);
    await expect(updateChannelReasoningResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        modelId: "pi-opus",
        reasoningLevel: "high",
      }),
    });
    await expect(readStoredChannelModel(config.paths.agentsStoreFile, createChannelBody.channel.sessionAgentId)).resolves.toMatchObject({
      thinkingLevel: "high",
    });

    const codexDefaultReasoning = resolveModelDescriptorFromPreset("pi-codex").thinkingLevel;
    const updateChannelModelResponse = await fetch(`${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({
        modelId: "pi-codex",
      }),
    });
    expect(updateChannelModelResponse.status).toBe(200);
    await expect(updateChannelModelResponse.json()).resolves.toMatchObject({
      ok: true,
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        modelId: "pi-5.5",
        reasoningLevel: codexDefaultReasoning,
      }),
    });
    await expect(readStoredChannelModel(config.paths.agentsStoreFile, createChannelBody.channel.sessionAgentId)).resolves.toMatchObject({
      thinkingLevel: codexDefaultReasoning,
      modelId: resolveModelDescriptorFromPreset("pi-codex").modelId,
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
        modelId: "pi-5.5",
        reasoningLevel: codexDefaultReasoning,
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

    const archiveChannelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}/archive`,
      {
        method: "POST",
        headers: { cookie: adminCookieHeader },
      },
    );
    expect(archiveChannelResponse.status).toBe(200);
    const archiveChannelBody = await archiveChannelResponse.json() as {
      ok: true;
      channel: { channelId: string; archived: boolean; archivedAt?: string };
    };
    expect(archiveChannelBody).toMatchObject({
      ok: true,
      channel: {
        channelId: createChannelBody.channel.channelId,
        archived: true,
      },
    });
    expect(archiveChannelBody.channel.archivedAt).toBeTruthy();

    const archivedChannelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
      { headers: { cookie: adminCookieHeader } },
    );
    expect(archivedChannelResponse.status).toBe(200);
    await expect(archivedChannelResponse.json()).resolves.toMatchObject({
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        archived: true,
      }),
    });

    const channelsAfterArchiveResponse = await fetch(`${baseUrl}/api/collaboration/channels`, {
      headers: { cookie: adminCookieHeader },
    });
    expect(channelsAfterArchiveResponse.status).toBe(200);
    await expect(channelsAfterArchiveResponse.json()).resolves.toEqual({ channels: [] });
  });

  it("returns descriptor-effective channel model fields when channel DB model fields are stale", async () => {
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

    const createChannelResponse = await fetch(`${baseUrl}/api/collaboration/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookieHeader,
      },
      body: JSON.stringify({ name: "Stale DB model channel" }),
    });
    expect(createChannelResponse.status).toBe(200);
    const createChannelBody = await createChannelResponse.json() as {
      channel: { channelId: string; sessionAgentId: string };
    };

    const updateChannelModelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminCookieHeader,
        },
        body: JSON.stringify({ modelId: "pi-5.4" }),
      },
    );
    expect(updateChannelModelResponse.status).toBe(200);

    await expect(readStoredChannelModel(config.paths.agentsStoreFile, createChannelBody.channel.sessionAgentId)).resolves.toMatchObject({
      modelId: resolveModelDescriptorFromPreset("pi-5.4").modelId,
    });

    const dbHelpers = await createCollaborationDbHelpers(config);
    dbHelpers.updateChannel(createChannelBody.channel.channelId, {
      modelId: "pi-opus",
      modelThinkingLevel: "low",
      updatedAt: new Date().toISOString(),
    });

    const channelResponse = await fetch(
      `${baseUrl}/api/collaboration/channels/${encodeURIComponent(createChannelBody.channel.channelId)}`,
      { headers: { cookie: adminCookieHeader } },
    );
    expect(channelResponse.status).toBe(200);
    await expect(channelResponse.json()).resolves.toMatchObject({
      channel: expect.objectContaining({
        channelId: createChannelBody.channel.channelId,
        modelId: "pi-5.4",
        reasoningLevel: resolveModelDescriptorFromPreset("pi-5.4").thinkingLevel,
      }),
    });
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

function createSpecialistBody(overrides: Partial<{
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  provider: string;
  reasoningLevel: string;
  promptBody: string;
}> = {}): Record<string, unknown> {
  return {
    displayName: "Collab Specialist",
    color: "#3366ff",
    enabled: true,
    whenToUse: "Use for collaboration tasks",
    modelId: "gpt-5.4",
    provider: "openai-codex",
    reasoningLevel: "medium",
    promptBody: "You are a collaboration specialist.",
    ...overrides,
  };
}

async function readStoredChannelModel(
  agentsStoreFile: string,
  sessionAgentId: string,
): Promise<{ modelId: string; thinkingLevel: string }> {
  const store = JSON.parse(await readFile(agentsStoreFile, "utf8")) as {
    agents: Array<{ agentId: string; model: { modelId: string; thinkingLevel: string } }>;
  };
  const agent = store.agents.find((entry) => entry.agentId === sessionAgentId);
  if (!agent) {
    throw new Error(`Missing persisted channel agent ${sessionAgentId}`);
  }

  return agent.model;
}

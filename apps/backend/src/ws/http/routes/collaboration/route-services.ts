import type { CollaborationSettingsService } from "../../../../collaboration/settings-service.js";
import {
  createCollaborationDbHelpers,
  type CollaborationDbHelpers,
} from "../../../../collaboration/collab-db-helpers.js";
import { CollaborationAuditService } from "../../../../collaboration/audit-service.js";
import {
  getOrCreateCollaborationBetterAuthService,
  type CollaborationBetterAuthService,
} from "../../../../collaboration/auth/better-auth-service.js";
import {
  CollaborationInviteService,
} from "../../../../collaboration/invite-service.js";
import {
  CollaborationUserService,
} from "../../../../collaboration/user-service.js";
import {
  CollaborationWorkspaceService,
  type CollaborationWorkspaceServiceSwarmManager,
} from "../../../../collaboration/workspace-service.js";
import {
  CollaborationChannelService,
  type CollaborationChannelServiceSwarmManager,
} from "../../../../collaboration/channel-service.js";
import { ChannelPromptOverlayService } from "../../../../collaboration/channel-prompt-overlay-service.js";
import { CollaborationCategoryService } from "../../../../collaboration/category-service.js";
import type {
  CollaborationReadinessRequestService,
} from "../../../../collaboration/readiness-service.js";
import type { SwarmConfig } from "../../../../swarm/types.js";
import type {
  CollaborationCategory,
  CollaborationChannel,
  PromptPreviewResponse,
} from "@forge/protocol";

export interface CollaborationRouteBroadcasts {
  broadcastChannelCreated(channel: CollaborationChannel): void;
  broadcastChannelUpdated(channel: CollaborationChannel): void;
  broadcastChannelArchived(workspaceId: string, channelId: string): void;
  broadcastChannelReordered(channels: CollaborationChannel[]): void;
  broadcastCategoryCreated(category: CollaborationCategory): void;
  broadcastCategoryUpdated(category: CollaborationCategory): void;
  broadcastCategoryDeleted(workspaceId: string, categoryId: string): void;
  broadcastCategoryReordered(categories: CollaborationCategory[]): void;
}

export interface CollaborationRouteServices {
  authService: CollaborationBetterAuthService;
  dbHelpers: CollaborationDbHelpers;
  auditService: CollaborationAuditService;
  inviteService: CollaborationInviteService;
  userService: CollaborationUserService;
  workspaceService: CollaborationWorkspaceService;
  channelService: CollaborationChannelService;
  promptOverlayService: ChannelPromptOverlayService;
  categoryService: CollaborationCategoryService;
  broadcasts: CollaborationRouteBroadcasts | null;
}

export interface CollaborationRouteSwarmManager
  extends CollaborationWorkspaceServiceSwarmManager,
    CollaborationChannelServiceSwarmManager {
  previewManagerSystemPromptForAgent?: (agentId: string) => Promise<PromptPreviewResponse>;
}

export interface CollaborationRouteContext {
  config: SwarmConfig;
  settingsService: CollaborationSettingsService;
  readinessService?: CollaborationReadinessRequestService;
  swarmManager?: CollaborationRouteSwarmManager;
  broadcasts?: CollaborationRouteBroadcasts;
}

export function createCollaborationRouteServicesGetter(context: CollaborationRouteContext): () => Promise<CollaborationRouteServices> {
  let servicesPromise: Promise<CollaborationRouteServices> | null = null;

  return async (): Promise<CollaborationRouteServices> => {
    if (!servicesPromise) {
      servicesPromise = createCollaborationRouteServices(context);
    }

    return servicesPromise;
  };
}

async function createCollaborationRouteServices(
  context: CollaborationRouteContext,
): Promise<CollaborationRouteServices> {
  const [dbHelpers, authService] = await Promise.all([
    createCollaborationDbHelpers(context.config),
    getOrCreateCollaborationBetterAuthService(context.config),
  ]);
  const database = dbHelpers.database;
  const auditService = new CollaborationAuditService(database);

  return {
    authService,
    dbHelpers,
    auditService,
    inviteService: new CollaborationInviteService(database, authService, context.settingsService, auditService),
    userService: new CollaborationUserService(database, authService),
    workspaceService: new CollaborationWorkspaceService(dbHelpers, context.swarmManager, context.config),
    channelService: new CollaborationChannelService(dbHelpers, context.swarmManager, context.config.paths.dataDir),
    promptOverlayService: new ChannelPromptOverlayService(dbHelpers, context.config.paths.dataDir),
    categoryService: new CollaborationCategoryService(dbHelpers),
    broadcasts: context.broadcasts ?? null,
  };
}

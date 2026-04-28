import type { HttpRoute } from "../shared/http-route.js";
import type { CollaborationSettingsService } from "../../../collaboration/settings-service.js";
import type { CollaborationReadinessRequestService } from "../../../collaboration/readiness-service.js";
import {
  createCollaborationChannelRoutes,
} from "./collaboration/channel-routes.js";
import {
  createCollaborationCategoryRoutes,
} from "./collaboration/category-routes.js";
import {
  createCollaborationInviteRoutes,
} from "./collaboration/invite-routes.js";
import {
  createCollaborationMeRoutes,
} from "./collaboration/me-routes.js";
import {
  createCollaborationRouteServicesGetter,
  type CollaborationRouteBroadcasts,
  type CollaborationRouteSwarmManager,
} from "./collaboration/route-services.js";
import { createCollaborationStatusRoutes } from "./collaboration/status-routes.js";
import { createCollaborationUserRoutes } from "./collaboration/user-routes.js";
import type { SwarmConfig } from "../../../swarm/types.js";

export function createCollaborationRoutes(options: {
  config: SwarmConfig;
  settingsService: CollaborationSettingsService;
  readinessService?: CollaborationReadinessRequestService;
  swarmManager?: CollaborationRouteSwarmManager;
  broadcasts?: CollaborationRouteBroadcasts;
}): HttpRoute[] {
  const getServices = createCollaborationRouteServicesGetter(options);

  return [
    ...createCollaborationStatusRoutes({ settingsService: options.settingsService }),
    ...createCollaborationMeRoutes({ getServices }),
    ...createCollaborationUserRoutes({ getServices }),
    ...createCollaborationInviteRoutes({ getServices }),
    ...createCollaborationCategoryRoutes({ getServices, readinessService: options.readinessService }),
    ...createCollaborationChannelRoutes({
      config: options.config,
      getServices,
      readinessService: options.readinessService,
      swarmManager: options.swarmManager,
    }),
  ];
}

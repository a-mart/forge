import { readFile } from "node:fs/promises";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MANAGER_SCHEDULES_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/schedules$/;

interface ScheduleHttpRecord {
  id: string;
  name: string;
  cron: string;
  message: string;
  oneShot: boolean;
  timezone: string;
  createdAt: string;
  nextFireAt: string;
  lastFiredAt?: string;
}

export function createSchedulerRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => MANAGER_SCHEDULES_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "GET, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveSchedulesRoute(requestUrl.pathname);
        if (!route) {
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        if (!isManagerAgent(swarmManager, route.managerId)) {
          sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
          return;
        }

        try {
          const schedulesFile = getScheduleFilePath(swarmManager.getConfig().paths.dataDir, route.managerId);
          const raw = await readFile(schedulesFile, "utf8");
          const parsed = JSON.parse(raw) as { schedules?: unknown };

          if (!parsed || !Array.isArray(parsed.schedules)) {
            sendJson(response, 200, { schedules: [] });
            return;
          }

          const schedules = parsed.schedules
            .map((entry) => normalizeScheduleRecord(entry))
            .filter((entry): entry is ScheduleHttpRecord => entry !== undefined);

          sendJson(response, 200, { schedules });
        } catch (error) {
          if (isEnoentError(error)) {
            sendJson(response, 200, { schedules: [] });
            return;
          }

          const message = error instanceof Error ? error.message : "Unable to load schedules";
          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}

type SchedulesRoute = {
  managerId: string;
};

function resolveSchedulesRoute(pathname: string): SchedulesRoute | null {
  const managerMatch = matchPathPattern(pathname, MANAGER_SCHEDULES_ENDPOINT_PATTERN);
  if (!managerMatch) {
    return null;
  }

  const managerId = decodePathSegment(managerMatch[1]);
  if (!managerId) {
    return null;
  }

  return { managerId };
}

function isManagerAgent(swarmManager: SwarmManager, managerId: string): boolean {
  const descriptor = swarmManager.getAgent(managerId);
  return Boolean(descriptor && descriptor.role === "manager");
}

function normalizeScheduleRecord(entry: unknown): ScheduleHttpRecord | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }

  const maybe = entry as Partial<ScheduleHttpRecord>;
  const id = normalizeScheduleRequiredString(maybe.id);
  const name = normalizeScheduleRequiredString(maybe.name);
  const cron = normalizeScheduleRequiredString(maybe.cron);
  const message = normalizeScheduleRequiredString(maybe.message);
  const timezone = normalizeScheduleRequiredString(maybe.timezone);
  const createdAt = normalizeScheduleRequiredString(maybe.createdAt);
  const nextFireAt = normalizeScheduleRequiredString(maybe.nextFireAt);
  const lastFiredAt = normalizeScheduleRequiredString(maybe.lastFiredAt);

  if (!id || !name || !cron || !message || !timezone || !createdAt || !nextFireAt) {
    return undefined;
  }

  return {
    id,
    name,
    cron,
    message,
    oneShot: typeof maybe.oneShot === "boolean" ? maybe.oneShot : false,
    timezone,
    createdAt,
    nextFireAt,
    lastFiredAt
  };
}

function normalizeScheduleRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

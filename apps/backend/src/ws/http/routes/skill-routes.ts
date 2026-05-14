import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  SkillBundleManifestV1,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillImportPreviewResponse,
  SkillImportResultResponse,
  SkillImportTarget,
  SkillInventoryResponse,
  SkillShareResponse,
} from "@forge/protocol";
import { SkillBundleError, SkillBundleValidationError } from "../../../swarm/skills/skill-bundle-service.js";
import { SkillSharingError, type ImportSkillOptions } from "../../../swarm/skills/skill-sharing-service.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SETTINGS_SKILLS_ENDPOINT_PATH = "/api/settings/skills";
const SKILL_ROUTE_METHODS = "GET, POST, OPTIONS";
const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;
const SKILL_BUNDLE_JSON_BODY_LIMIT_BYTES = 35 * 1024 * 1024;

type SkillRouteAction = "files" | "content";
type SkillImportRouteAction = "preview-url" | "preview-bundle" | "import";

interface SkillRouteSwarmManager {
  listUserProfiles(): Array<{ profileId: string }>;
  listSkillMetadata(profileId?: string): Promise<SkillInventoryResponse["skills"]>;
  listSkillFiles(skillId: string, relativePath?: string): Promise<SkillFilesResponse>;
  getSkillFileContent(skillId: string, relativePath: string): Promise<SkillFileContentResponse>;
  shareSkill(skillId: string): Promise<SkillShareResponse>;
  previewSkillImportFromUrl(url: string, target?: SkillImportTarget): Promise<SkillImportPreviewResponse>;
  previewSkillImportBundle(bundle: SkillBundleManifestV1, target?: SkillImportTarget): Promise<SkillImportPreviewResponse>;
  importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse>;
}

export function createSkillRoutes(options: { swarmManager: SkillRouteSwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: SKILL_ROUTE_METHODS,
      matches: (pathname) => pathname === SETTINGS_SKILLS_ENDPOINT_PATH
        || parseSkillRoutePath(pathname) !== null
        || parseSkillShareRoutePath(pathname) !== null
        || parseSkillImportRoutePath(pathname) !== null,
      handle: async (request, response, requestUrl) => {
        try {
          await handleSkillHttpRequest(swarmManager, request, response, requestUrl);
        } catch (error) {
          if (!response.headersSent) {
            const mapped = mapSkillRouteError(error);
            sendJson(response, mapped.statusCode, mapped.body);
          }
        }
      }
    }
  ];
}

async function handleSkillHttpRequest(
  swarmManager: SkillRouteSwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<void> {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, response, SKILL_ROUTE_METHODS);
    response.statusCode = 204;
    response.end();
    return;
  }

  applyCorsHeaders(request, response, SKILL_ROUTE_METHODS);
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && requestUrl.pathname === SETTINGS_SKILLS_ENDPOINT_PATH) {
    const profileId = requestUrl.searchParams.get("profileId")?.trim() || undefined;
    if (profileId && !profileExists(swarmManager, profileId)) {
      sendJson(response, 404, { error: `Unknown profile: ${profileId}` });
      return;
    }

    const skills = await swarmManager.listSkillMetadata(profileId);
    const payload: SkillInventoryResponse = { skills };
    sendJson(response, 200, payload as unknown as Record<string, unknown>);
    return;
  }

  if (request.method === "POST") {
    const shareRoute = parseSkillShareRoutePath(requestUrl.pathname);
    if (shareRoute) {
      const result = await swarmManager.shareSkill(shareRoute.skillId);
      sendJson(response, 200, result as unknown as Record<string, unknown>);
      return;
    }

    const importRoute = parseSkillImportRoutePath(requestUrl.pathname);
    if (importRoute) {
      await handleSkillImportRoute(swarmManager, request, response, importRoute.action);
      return;
    }
  }

  if (request.method === "GET") {
    const parsedRoute = parseSkillRoutePath(requestUrl.pathname);
    if (parsedRoute?.action === "files") {
      const relativePath = requestUrl.searchParams.get("path") ?? "";
      const result: SkillFilesResponse = await swarmManager.listSkillFiles(parsedRoute.skillId, relativePath);
      sendJson(response, 200, result as unknown as Record<string, unknown>);
      return;
    }

    if (parsedRoute?.action === "content") {
      const relativePath = requestUrl.searchParams.get("path");
      if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
        sendJson(response, 400, { error: "path must be a non-empty relative path." });
        return;
      }

      const result: SkillFileContentResponse = await swarmManager.getSkillFileContent(parsedRoute.skillId, relativePath);
      sendJson(response, 200, result as unknown as Record<string, unknown>);
      return;
    }
  }

  response.setHeader("Allow", SKILL_ROUTE_METHODS);
  sendJson(response, 405, { error: "Method Not Allowed" });
}

async function handleSkillImportRoute(
  swarmManager: SkillRouteSwarmManager,
  request: IncomingMessage,
  response: ServerResponse,
  action: SkillImportRouteAction
): Promise<void> {
  const body = await readJsonBody(
    request,
    action === "preview-bundle" || action === "import" ? SKILL_BUNDLE_JSON_BODY_LIMIT_BYTES : DEFAULT_JSON_BODY_LIMIT_BYTES
  );

  if (!isRecord(body)) {
    sendJson(response, 400, { error: "Request body must be a JSON object." });
    return;
  }

  if (action === "preview-url") {
    const url = body.url;
    if (typeof url !== "string" || url.trim().length === 0) {
      sendJson(response, 400, { error: "url must be a non-empty string." });
      return;
    }
    const target = parseImportTarget(body.target, swarmManager);
    const result = await swarmManager.previewSkillImportFromUrl(url, target);
    sendJson(response, 200, result as unknown as Record<string, unknown>);
    return;
  }

  if (action === "preview-bundle") {
    if (!("bundle" in body)) {
      sendJson(response, 400, { error: "bundle is required." });
      return;
    }
    const target = parseImportTarget(body.target, swarmManager);
    const result = await swarmManager.previewSkillImportBundle(body.bundle as SkillBundleManifestV1, target);
    sendJson(response, 200, result as unknown as Record<string, unknown>);
    return;
  }

  const source = isRecord(body.source) ? body.source : undefined;
  if (!source) {
    sendJson(response, 400, { error: "source is required." });
    return;
  }
  const target = parseImportTarget(body.target, swarmManager);
  const conflictStrategy = body.conflictStrategy === "replace" ? "replace" : "reject";
  const confirmReplace = body.confirmReplace === true;
  const result = await swarmManager.importSkill({
    source: {
      ...(typeof source.url === "string" ? { url: source.url } : {}),
      ...("bundle" in source ? { bundle: source.bundle } : {})
    },
    target,
    conflictStrategy,
    confirmReplace
  });
  sendJson(response, 200, result as unknown as Record<string, unknown>);
}

function parseImportTarget(value: unknown, swarmManager: SkillRouteSwarmManager): SkillImportTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new SkillSharingError("invalid_import_target", "target must be an object.", 400);
  }

  if (value.scope === "global") {
    return { scope: "global" };
  }
  if (value.scope === "profile") {
    if (typeof value.profileId !== "string" || value.profileId.trim().length === 0) {
      throw new SkillSharingError("invalid_import_target", "Profile imports require profileId.", 400);
    }
    const profileId = value.profileId.trim();
    if (!profileExists(swarmManager, profileId)) {
      throw new SkillSharingError("unknown_profile", `Unknown profile: ${profileId}`, 404);
    }
    return { scope: "profile", profileId };
  }

  throw new SkillSharingError("invalid_import_target", "target.scope must be global or profile.", 400);
}

function profileExists(swarmManager: SkillRouteSwarmManager, profileId: string): boolean {
  return swarmManager.listUserProfiles().some((profile) => profile.profileId === profileId);
}

function parseSkillRoutePath(pathname: string): { skillId: string; action: SkillRouteAction } | null {
  const match = pathname.match(/^\/api\/settings\/skills\/([^/]+)\/(files|content)$/);
  if (!match) {
    return null;
  }

  const encodedSkillId = match[1];
  const action = match[2];
  if (!encodedSkillId || (action !== "files" && action !== "content")) {
    return null;
  }

  return decodeSkillIdRoute(encodedSkillId, action);
}

function parseSkillShareRoutePath(pathname: string): { skillId: string } | null {
  const match = pathname.match(/^\/api\/settings\/skills\/([^/]+)\/share$/);
  if (!match || !match[1]) {
    return null;
  }

  try {
    return { skillId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

function parseSkillImportRoutePath(pathname: string): { action: SkillImportRouteAction } | null {
  if (pathname === `${SETTINGS_SKILLS_ENDPOINT_PATH}/import`) {
    return { action: "import" };
  }

  const match = pathname.match(/^\/api\/settings\/skills\/import\/(preview-url|preview-bundle)$/);
  if (!match) {
    return null;
  }
  return { action: match[1] as SkillImportRouteAction };
}

function decodeSkillIdRoute(skillId: string, action: SkillRouteAction): { skillId: string; action: SkillRouteAction } | null {
  try {
    return {
      skillId: decodeURIComponent(skillId),
      action
    };
  } catch {
    return null;
  }
}

function mapSkillRouteError(error: unknown): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof SkillSharingError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {})
      }
    };
  }

  if (error instanceof SkillBundleValidationError) {
    return {
      statusCode: 400,
      body: {
        error: error.message || "Invalid skill bundle.",
        code: error.code,
        details: error.issues
      }
    };
  }

  if (error instanceof SkillBundleError) {
    return {
      statusCode: resolveSkillBundleErrorStatusCode(error),
      body: {
        error: error.message,
        code: error.code,
        ...(error.path ? { path: error.path } : {})
      }
    };
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  return {
    statusCode: resolveSkillRouteStatusCode(message),
    body: { error: message }
  };
}

function resolveSkillBundleErrorStatusCode(error: SkillBundleError): number {
  if (error.code === "unknown_skill") return 404;
  if (error.code === "unshareable_skill_source" || error.code === "sensitive_file") return 403;
  if (error.code === "oversized_file" || error.code === "oversized_bundle" || error.code === "too_many_files") return 413;
  return 400;
}

function resolveSkillRouteStatusCode(message: string): number {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("relative path") ||
    normalized.includes("traversal")
  ) {
    return 400;
  }

  if (normalized.includes("unknown skill") || normalized.includes("not found")) {
    return 404;
  }

  if (normalized.includes("too large")) {
    return 413;
  }

  if (
    normalized.includes("outside skill root") ||
    normalized.includes("not readable")
  ) {
    return 403;
  }

  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

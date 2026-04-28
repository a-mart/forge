import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, normalize as normalizePath, resolve as resolvePath } from "node:path";
import type { CollaborationWorkspace, PromptPreviewResponse } from "@forge/protocol";
import {
  getCollaborationRequestAuthContext,
  type CollaborationRequestAuthContext,
} from "../../../../collaboration/auth/collaboration-auth-middleware.js";
import {
  CollaborationCategoryServiceError,
} from "../../../../collaboration/category-service.js";
import {
  CollaborationChannelServiceError,
} from "../../../../collaboration/channel-service.js";
import {
  CollaborationInviteServiceError,
} from "../../../../collaboration/invite-service.js";
import {
  CollaborationReadinessError,
  type CollaborationReadinessRequestService,
} from "../../../../collaboration/readiness-service.js";
import {
  CollaborationUserServiceError,
  type CollaborationUserState,
} from "../../../../collaboration/user-service.js";
import { sendJson } from "../../../http-utils.js";
import type { CollaborationRouteServices } from "./route-services.js";
import { evaluateCollaborationAdminAccess, evaluateCollaborationAuthenticatedAccess } from "../../../../collaboration/auth/collaboration-auth-middleware.js";

export async function resolveRequestAuthContext(
  request: IncomingMessage,
  getServices: () => Promise<CollaborationRouteServices>,
): Promise<CollaborationRequestAuthContext | null> {
  const cached = getCollaborationRequestAuthContext(request);
  if (cached) {
    return cached;
  }

  const { authService, userService } = await getServices();
  const session = await authService.getSessionFromRequest(request);
  if (!session) {
    return null;
  }

  const userState = userService.getUserState(session.user.id);
  if (!userState) {
    return null;
  }

  return {
    userId: userState.userId,
    email: userState.email,
    name: userState.name,
    role: userState.role,
    disabled: userState.disabled,
    passwordChangeRequired: userState.passwordChangeRequired,
    sessionId: session.session.id,
  };
}

export async function requireAuthenticatedRequestContext(
  request: IncomingMessage,
  response: ServerResponse,
  getServices: () => Promise<CollaborationRouteServices>,
): Promise<CollaborationRequestAuthContext | null> {
  const authContext = await resolveRequestAuthContext(request, getServices);
  const access = evaluateCollaborationAuthenticatedAccess(authContext);
  if (!access.ok) {
    sendJson(response, access.statusCode, { error: access.error });
    return null;
  }

  return access.authContext;
}

export async function requireAdminRequestContext(
  request: IncomingMessage,
  response: ServerResponse,
  getServices: () => Promise<CollaborationRouteServices>,
): Promise<CollaborationRequestAuthContext | null> {
  const authContext = await resolveRequestAuthContext(request, getServices);
  const access = evaluateCollaborationAdminAccess(authContext);
  if (!access.ok) {
    sendJson(response, access.statusCode, { error: access.error });
    return null;
  }

  return access.authContext;
}

export async function resolveDefaultWorkspace(
  getServices: () => Promise<CollaborationRouteServices>,
  readinessService?: CollaborationReadinessRequestService,
): Promise<CollaborationWorkspace | null> {
  if (readinessService) {
    const result = await readinessService.ensureCollaborationReady();
    return result.workspace;
  }

  const { workspaceService } = await getServices();
  return workspaceService.ensureDefaultWorkspace();
}

export async function requireDefaultWorkspace(
  response: ServerResponse,
  getServices: () => Promise<CollaborationRouteServices>,
  readinessService?: CollaborationReadinessRequestService,
): Promise<CollaborationWorkspace | null> {
  try {
    const workspace = await resolveDefaultWorkspace(getServices, readinessService);
    if (!workspace) {
      sendJson(response, 503, { error: "Collaboration workspace is not ready" });
      return null;
    }

    return workspace;
  } catch (error) {
    if (error instanceof CollaborationReadinessError) {
      sendJson(response, 503, { error: error.message, status: error.status as unknown as Record<string, unknown> });
      return null;
    }

    throw error;
  }
}

export function appendSetCookieHeaders(response: ServerResponse, cookies: string[]): void {
  if (cookies.length === 0) {
    return;
  }

  const existing = response.getHeader("Set-Cookie");
  const existingValues = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === "string"
      ? [existing]
      : [];
  response.setHeader("Set-Cookie", [...existingValues, ...cookies]);
}

export function toSessionUser(userState: CollaborationUserState) {
  return {
    userId: userState.userId,
    email: userState.email,
    name: userState.name,
    role: userState.role,
    disabled: userState.disabled,
    authMethods: userState.authMethods,
    createdAt: userState.createdAt,
    updatedAt: userState.updatedAt,
  };
}

export function parseSinglePathId(pathname: string, pattern: RegExp): string {
  const match = pathname.match(pattern);
  return decodeURIComponent(match?.[1] ?? "").trim();
}

export function expectObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

export function parseArchivedFilter(rawValue: string | null): "unarchived" | "archived" | "all" {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "false" || normalized === "unarchived") {
    return "unarchived";
  }

  if (normalized === "true" || normalized === "archived") {
    return "archived";
  }

  if (normalized === "all") {
    return "all";
  }

  throw new Error('archived must be one of "false", "true", or "all" when provided');
}

export function mapCollaborationUserErrorStatus(error: unknown): number {
  if (error instanceof CollaborationUserServiceError) {
    switch (error.code) {
      case "not_found":
        return 404;
      case "last_admin":
      case "invalid_password":
        return 400;
    }
  }

  return 500;
}

export function mapCollaborationInviteErrorStatus(error: unknown): number {
  if (error instanceof CollaborationInviteServiceError) {
    switch (error.code) {
      case "not_found":
        return 404;
      case "expired":
      case "revoked":
      case "consumed":
      case "unsupported":
      case "email_required":
      case "invalid_email":
      case "invalid_password":
      case "email_mismatch":
      case "duplicate_email":
      case "invalid_expires_in_days":
      case "missing_base_url":
        return 400;
    }
  }

  return 500;
}

export function mapCollaborationCategoryErrorStatus(error: unknown): number {
  if (error instanceof CollaborationCategoryServiceError) {
    switch (error.code) {
      case "not_found":
      case "invalid_category":
        return 404;
      case "duplicate_name":
      case "invalid_reorder":
        return 400;
    }
  }

  return 500;
}

export function mapCollaborationChannelErrorStatus(error: unknown): number {
  if (error instanceof CollaborationChannelServiceError) {
    switch (error.code) {
      case "not_found":
      case "invalid_category":
      case "orphaned_channel":
      case "orphaned_workspace":
        return 404;
      case "duplicate_slug":
      case "invalid_reorder":
        return 400;
      case "unavailable":
        return 503;
    }
  }

  return 500;
}

export function redactCollaborationPromptPreview(preview: PromptPreviewResponse, config: {
  paths: { dataDir: string; rootDir: string; resourcesDir?: string };
}) {
  return {
    sections: preview.sections.map((section) => ({
      label: section.label,
      content: redactCollaborationPromptPreviewContent(section.content, config),
    })),
  };
}

function redactCollaborationPromptPreviewContent(content: string, config: {
  paths: { dataDir: string; rootDir: string; resourcesDir?: string };
}): string {
  let redacted = content.replaceAll(/<location>([\s\S]*?)<\/location>/g, (match, rawLocation: string) => {
    const locationValue = typeof rawLocation === "string" ? rawLocation.trim() : "";
    if (!locationValue || !isAbsolutePromptPreviewPath(locationValue)) {
      return match;
    }

    return `<location><REDACTED_ABSOLUTE_PATH></location>`;
  });

  const replacements = Array.from(buildCollaborationPromptPreviewPathReplacements(config).entries()).sort(
    (left, right) => right[0].length - left[0].length,
  );

  for (const [pathValue, placeholder] of replacements) {
    redacted = redacted.split(pathValue).join(placeholder);
  }

  return redacted;
}

function isAbsolutePromptPreviewPath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function buildCollaborationPromptPreviewPathReplacements(config: {
  paths: { dataDir: string; rootDir: string; resourcesDir?: string };
}): Map<string, string> {
  const replacements = new Map<string, string>();

  const addPath = (pathValue: string | undefined, placeholder: string) => {
    const normalizedPath = typeof pathValue === "string" ? pathValue.trim() : "";
    if (!normalizedPath) {
      return;
    }

    const variants = new Set<string>([
      normalizedPath,
      normalizePath(normalizedPath),
      resolvePath(normalizedPath),
      normalizedPath.replaceAll("\\", "/"),
      normalizedPath.replaceAll("/", "\\"),
    ]);

    for (const variant of variants) {
      if (variant.trim().length > 0) {
        replacements.set(variant, placeholder);
      }
    }
  };

  const normalizedRootDir = config.paths.rootDir?.trim() ?? "";
  const normalizedResourcesDir = config.paths.resourcesDir?.trim() ?? "";

  addPath(config.paths.dataDir, "<FORGE_DATA_DIR>");
  addPath(config.paths.rootDir, "<FORGE_ROOT>");
  if (normalizedResourcesDir && normalizedResourcesDir !== normalizedRootDir) {
    addPath(config.paths.resourcesDir, "<FORGE_RESOURCES_DIR>");
  }

  return replacements;
}

import type { GitRepoTarget } from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import { GitSourceControlService } from "../services/git-source-control-service.js";
import type { HttpRoute } from "../shared/http-route.js";
import { resolveGitSourceControlContext } from "../shared/route-helpers.js";

const GIT_GET_METHODS = "GET, OPTIONS";

export function createGitSourceControlRoutes(options: {
  swarmManager: SwarmManager;
}): HttpRoute[] {
  const { swarmManager } = options;
  const service = new GitSourceControlService();

  return [
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => pathname === "/api/git/worktrees",
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, GIT_GET_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, GIT_GET_METHODS);
          response.setHeader("Allow", GIT_GET_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, GIT_GET_METHODS);

        try {
          const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
          const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
          const worktreeId = optionalTrimmedQuery(requestUrl.searchParams.get("worktreeId"));
          const context = await resolveGitSourceControlContext(
            swarmManager,
            agentId,
            repoTarget,
            worktreeId
          );
          const payload = await service.listWorktrees(swarmManager, context);
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    }
  ];
}

function requireNonEmptyQuery(searchParams: URLSearchParams, key: string): string {
  const value = searchParams.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value.trim();
}

function optionalTrimmedQuery(value: string | null): string | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}

function parseRepoTarget(rawValue: string | null): GitRepoTarget {
  if (rawValue === null || rawValue.trim().length === 0) {
    return "workspace";
  }

  const repoTarget = rawValue.trim();
  if (repoTarget !== "workspace" && repoTarget !== "versioning") {
    throw new Error("repoTarget must be one of: workspace, versioning.");
  }

  return repoTarget;
}

function resolveHttpStatusCode(message: string): number {
  const normalized = message.toLowerCase();

  if (normalized.includes("forbidden") || normalized.includes("not allowed")) {
    return 403;
  }

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("unknown or invalid worktreeid") ||
    normalized.includes("cannot resolve worktree context") ||
    normalized.includes("no cwd") ||
    normalized.includes("not a git repository")
  ) {
    return 400;
  }

  if (normalized.includes("unknown agent")) {
    return 404;
  }

  return 500;
}

import type {
  GitCreateBranchRequest,
  GitFetchRequest,
  GitPullFfOnlyRequest,
  GitRepoTarget,
  GitSwitchBranchRequest
} from "@forge/protocol";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import { GitSourceControlService } from "../services/git-source-control-service.js";
import {
  GitHostedProviderError,
  type GitHostedProviderOptions
} from "../services/git-hosted-provider.js";
import type { HttpRoute } from "../shared/http-route.js";
import { resolveGitSourceControlContext } from "../shared/route-helpers.js";

const GIT_GET_METHODS = "GET, OPTIONS";
const GIT_POST_METHODS = "POST, OPTIONS";

export function createGitSourceControlRoutes(options: {
  swarmManager: SwarmManager;
  hostedProviderOptions?: GitHostedProviderOptions;
}): HttpRoute[] {
  const { swarmManager, hostedProviderOptions } = options;
  const service = new GitSourceControlService({ hostedProviderOptions });

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
    },
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => pathname === "/api/git/branches",
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
          const payload = await service.listBranches(swarmManager, context);
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    },
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => pathname === "/api/git/mutation-preflight",
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
          const action = parsePreflightAction(requestUrl.searchParams.get("action"));
          const targetBranch = optionalTrimmedQuery(requestUrl.searchParams.get("targetBranch"));
          const remote = optionalTrimmedQuery(requestUrl.searchParams.get("remote"));
          const context = await resolveGitSourceControlContext(
            swarmManager,
            agentId,
            repoTarget,
            worktreeId
          );
          const payload = await service.buildMutationPreflight(swarmManager, context, {
            action,
            targetBranch,
            remote
          });
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    },
    createMutationRoute(swarmManager, {
      endpoint: "/api/git/fetch",
      methods: GIT_POST_METHODS,
      parseBody: parseFetchRequest,
      execute: async (context, body) => service.fetchOrigin(swarmManager, context, body)
    }),
    createMutationRoute(swarmManager, {
      endpoint: "/api/git/switch-branch",
      methods: GIT_POST_METHODS,
      parseBody: parseSwitchBranchRequest,
      execute: async (context, body) => service.switchBranch(swarmManager, context, body)
    }),
    createMutationRoute(swarmManager, {
      endpoint: "/api/git/create-branch",
      methods: GIT_POST_METHODS,
      parseBody: parseCreateBranchRequest,
      execute: async (context, body) => service.createBranch(swarmManager, context, body)
    }),
    createMutationRoute(swarmManager, {
      endpoint: "/api/git/pull-ff-only",
      methods: GIT_POST_METHODS,
      parseBody: parsePullFfOnlyRequest,
      execute: async (context, body) => service.pullFfOnly(swarmManager, context, body)
    }),
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => pathname === "/api/git/provider/status",
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
          const payload = await service.getProviderStatus(context);
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    },
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => pathname === "/api/git/pull-requests",
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
          const closedLimit = parseOptionalLimit(requestUrl.searchParams.get("closedLimit"), 10, 50);
          const openLimit = parseOptionalLimit(requestUrl.searchParams.get("openLimit"), 50, 100);
          const context = await resolveGitSourceControlContext(
            swarmManager,
            agentId,
            repoTarget,
            worktreeId
          );
          const payload = await service.listPullRequests(context, { openLimit, closedLimit });
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    },
    {
      methods: GIT_GET_METHODS,
      matches: (pathname) => /^\/api\/git\/pull-requests\/\d+$/.test(pathname),
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
          const number = parsePullRequestNumber(requestUrl.pathname);
          const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
          const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
          const worktreeId = optionalTrimmedQuery(requestUrl.searchParams.get("worktreeId"));
          const context = await resolveGitSourceControlContext(
            swarmManager,
            agentId,
            repoTarget,
            worktreeId
          );
          const payload = await service.getPullRequestDetail(context, number);
          if (!payload) {
            sendJson(response, 404, { error: "Pull request is unavailable for this repository context." });
            return;
          }

          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          if (error instanceof GitHostedProviderError) {
            sendJson(response, error.httpStatus, {
              error: error.message,
              code: error.code
            });
            return;
          }

          const message = error instanceof Error ? error.message : "Git source-control request failed.";
          sendJson(response, resolveHttpStatusCode(message), { error: message });
        }
      }
    }
  ];
}

function createMutationRoute<T extends { agentId: string; repoTarget?: GitRepoTarget; worktreeId?: string }>(
  swarmManager: SwarmManager,
  options: {
    endpoint: string;
    methods: string;
    parseBody: (body: unknown) => T;
    execute: (
      context: Awaited<ReturnType<typeof resolveGitSourceControlContext>>,
      body: T
    ) => Promise<{ success: boolean; errors: string[] }>;
  }
): HttpRoute {
  return {
    methods: options.methods,
    matches: (pathname) => pathname === options.endpoint,
    handle: async (request, response) => {
      if (request.method === "OPTIONS") {
        applyCorsHeaders(request, response, options.methods);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method !== "POST") {
        applyCorsHeaders(request, response, options.methods);
        response.setHeader("Allow", options.methods);
        sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }

      applyCorsHeaders(request, response, options.methods);

      try {
        const body = options.parseBody(await readJsonBody(request));
        const context = await resolveGitSourceControlContext(
          swarmManager,
          body.agentId,
          body.repoTarget ?? "workspace",
          body.worktreeId
        );
        const payload = await options.execute(context, body);
        sendJson(response, payload.success ? 200 : 409, payload as unknown as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Git source-control request failed.";
        sendJson(response, resolveHttpStatusCode(message), { error: message });
      }
    }
  };
}

type PreflightAction = "fetch" | "switch-branch" | "create-branch" | "pull-ff-only";

function parsePreflightAction(rawValue: string | null): PreflightAction {
  if (rawValue === null || rawValue.trim().length === 0) {
    throw new Error("action must be one of: fetch, switch-branch, create-branch, pull-ff-only.");
  }

  const action = rawValue.trim();
  if (
    action !== "fetch" &&
    action !== "switch-branch" &&
    action !== "create-branch" &&
    action !== "pull-ff-only"
  ) {
    throw new Error("action must be one of: fetch, switch-branch, create-branch, pull-ff-only.");
  }

  return action;
}

function parseMutationBase(body: unknown): {
  agentId: string;
  repoTarget?: GitRepoTarget;
  worktreeId?: string;
  expectedHead: string;
  expectedStatusHash: string;
} {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be a JSON object.");
  }

  const record = body as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  if (agentId.length === 0) {
    throw new Error("agentId must be a non-empty string.");
  }

  const expectedHead = typeof record.expectedHead === "string" ? record.expectedHead.trim() : "";
  const expectedStatusHash =
    typeof record.expectedStatusHash === "string" ? record.expectedStatusHash.trim() : "";
  if (expectedHead.length === 0) {
    throw new Error("expectedHead must be a non-empty string.");
  }
  if (expectedStatusHash.length === 0) {
    throw new Error("expectedStatusHash must be a non-empty string.");
  }

  const repoTarget = parseOptionalRepoTarget(record.repoTarget);
  const worktreeId =
    typeof record.worktreeId === "string" && record.worktreeId.trim().length > 0
      ? record.worktreeId.trim()
      : undefined;

  return {
    agentId,
    repoTarget,
    worktreeId,
    expectedHead,
    expectedStatusHash
  };
}

function parseFetchRequest(body: unknown): GitFetchRequest {
  const base = parseMutationBase(body);
  const record = body as Record<string, unknown>;
  const remote =
    typeof record.remote === "string" && record.remote.trim().length > 0
      ? record.remote.trim()
      : undefined;

  return {
    ...base,
    remote
  };
}

function parseSwitchBranchRequest(body: unknown): GitSwitchBranchRequest {
  const base = parseMutationBase(body);
  const record = body as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  if (branch.length === 0) {
    throw new Error("branch must be a non-empty string.");
  }

  return {
    ...base,
    branch
  };
}

function parseCreateBranchRequest(body: unknown): GitCreateBranchRequest {
  const base = parseMutationBase(body);
  const record = body as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  if (branch.length === 0) {
    throw new Error("branch must be a non-empty string.");
  }

  const startPoint =
    typeof record.startPoint === "string" && record.startPoint.trim().length > 0
      ? record.startPoint.trim()
      : undefined;

  return {
    ...base,
    branch,
    startPoint
  };
}

function parsePullFfOnlyRequest(body: unknown): GitPullFfOnlyRequest {
  const base = parseMutationBase(body);
  const record = body as Record<string, unknown>;
  const remote =
    typeof record.remote === "string" && record.remote.trim().length > 0
      ? record.remote.trim()
      : undefined;

  return {
    ...base,
    remote
  };
}

function parseOptionalLimit(rawValue: string | null, defaultValue: number, maxValue: number): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("limit must be a positive integer.");
  }

  return Math.min(parsed, maxValue);
}

function parsePullRequestNumber(pathname: string): number {
  const match = /^\/api\/git\/pull-requests\/(\d+)$/.exec(pathname);
  if (!match) {
    throw new Error("Invalid pull request number.");
  }

  const number = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Invalid pull request number.");
  }

  return number;
}

function parseOptionalRepoTarget(value: unknown): GitRepoTarget | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("repoTarget must be one of: workspace, versioning.");
  }

  const repoTarget = value.trim();
  if (repoTarget !== "workspace" && repoTarget !== "versioning") {
    throw new Error("repoTarget must be one of: workspace, versioning.");
  }

  return repoTarget;
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

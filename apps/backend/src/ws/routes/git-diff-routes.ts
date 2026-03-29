import type { GitCommitDetail, GitDiffResult, GitFileLogResult, GitLogResult, GitRepoTarget } from "@forge/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import { GitDiffService } from "./git-diff-service.js";
import type { HttpRoute } from "./http-route.js";
import { resolveTrackedVersionedPathReference } from "../../versioning/versioned-paths.js";
import { resolveGitRepoContext } from "./route-utils.js";

const SHA_PATTERN = /^[a-f0-9]{4,40}$/i;
const GIT_GET_METHODS = "GET, OPTIONS";
const MAX_LOG_LIMIT = 200;

export function createGitDiffRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;
  const service = new GitDiffService();

  const handleGet = (
    endpoint: string,
    handler: (requestUrl: URL) => Promise<unknown>
  ): HttpRoute => ({
    methods: GIT_GET_METHODS,
    matches: (pathname) => pathname === endpoint,
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
        const payload = await handler(requestUrl);
        sendJson(response, 200, payload as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Git request failed.";
        const statusCode = resolveHttpStatusCode(message);
        sendJson(response, statusCode, { error: message });
      }
    }
  });

  return [
    handleGet("/api/git/status", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      return service.getStatus(repoContext.cwd, repoContext);
    }),
    handleGet("/api/git/diff", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const file = requireNonEmptyQuery(requestUrl.searchParams, "file");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      if (repoContext.notInitialized) {
        return createNotInitializedDiffResult();
      }

      return service.getFileDiff(repoContext.cwd, file);
    }),
    handleGet("/api/git/log", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const limit = parseNumberParam(requestUrl.searchParams.get("limit"), 50, 1, MAX_LOG_LIMIT, "limit");
      const offset = parseNumberParam(requestUrl.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      if (repoContext.notInitialized) {
        return createNotInitializedLogResult();
      }

      return service.getLog(repoContext.cwd, limit, offset);
    }),
    handleGet("/api/git/file-log", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const file = requireNonEmptyQuery(requestUrl.searchParams, "file");
      const limit = parseNumberParam(requestUrl.searchParams.get("limit"), 50, 1, MAX_LOG_LIMIT, "limit");
      const offset = parseNumberParam(requestUrl.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER, "offset");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      if (repoTarget !== "versioning") {
        throw new Error("file-log is only available for repoTarget=versioning.");
      }

      const includeStatsParam = requestUrl.searchParams.get("includeStats");
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      const trackedFile = resolveTrackedVersionedPathReference(repoContext.cwd, file);
      if (!trackedFile) {
        throw new Error("file must resolve to a tracked versioning path.");
      }
      if (repoContext.notInitialized) {
        return createNotInitializedFileLogResult(trackedFile.gitPath);
      }

      return service.getFileLog(repoContext.cwd, trackedFile.gitPath, limit, offset, {
        includeStats: includeStatsParam === "1" || includeStatsParam === "true"
      });
    }),
    handleGet("/api/git/file-section-provenance", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const file = requireNonEmptyQuery(requestUrl.searchParams, "file");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      if (repoTarget !== "versioning") {
        throw new Error("file-section-provenance is only available for repoTarget=versioning.");
      }

      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      const trackedFile = resolveTrackedVersionedPathReference(repoContext.cwd, file);
      if (!trackedFile) {
        throw new Error("file must resolve to a tracked versioning path.");
      }

      return service.getFileSectionProvenance(repoContext.cwd, trackedFile.gitPath, {
        notInitialized: repoContext.notInitialized === true
      });
    }),
    handleGet("/api/git/commit", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const sha = requireValidSha(requestUrl.searchParams.get("sha"));
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      if (repoContext.notInitialized) {
        return createNotInitializedCommitDetail(sha);
      }

      return service.getCommitDetail(repoContext.cwd, sha);
    }),
    handleGet("/api/git/commit-diff", async (requestUrl) => {
      const agentId = requireNonEmptyQuery(requestUrl.searchParams, "agentId");
      const sha = requireValidSha(requestUrl.searchParams.get("sha"));
      const file = requireNonEmptyQuery(requestUrl.searchParams, "file");
      const repoTarget = parseRepoTarget(requestUrl.searchParams.get("repoTarget"));
      const repoContext = resolveGitRepoContext(swarmManager, agentId, repoTarget);
      if (repoContext.notInitialized) {
        return createNotInitializedDiffResult();
      }

      return service.getCommitFileDiff(repoContext.cwd, sha, file);
    })
  ];
}

function requireNonEmptyQuery(searchParams: URLSearchParams, key: string): string {
  const value = searchParams.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value.trim();
}

function requireValidSha(rawSha: string | null): string {
  if (!rawSha || rawSha.trim().length === 0) {
    throw new Error("sha must be a non-empty string.");
  }

  const sha = rawSha.trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error("Invalid sha parameter.");
  }

  return sha;
}

function parseNumberParam(
  rawValue: string | null,
  fallback: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
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

function createNotInitializedDiffResult(): GitDiffResult {
  return {
    oldContent: "",
    newContent: "",
    notInitialized: true
  };
}

function createNotInitializedLogResult(): GitLogResult {
  return {
    commits: [],
    hasMore: false,
    notInitialized: true
  };
}

function createNotInitializedCommitDetail(sha: string): GitCommitDetail {
  return {
    sha,
    message: "",
    author: "",
    date: "",
    files: [],
    notInitialized: true
  };
}

function createNotInitializedFileLogResult(file: string): GitFileLogResult {
  return {
    file,
    commits: [],
    stats: {
      totalEdits: 0,
      lastModifiedAt: null,
      editsToday: 0,
      editsThisWeek: 0
    },
    hasMore: false,
    notInitialized: true
  };
}

function resolveHttpStatusCode(message: string): number {
  const normalized = message.toLowerCase();

  if (normalized.includes("forbidden") || normalized.includes("not allowed")) {
    return 403;
  }

  if (
    normalized.includes("must be") ||
    normalized.includes("invalid") ||
    normalized.includes("outside repository") ||
    normalized.includes("tracked versioning path") ||
    normalized.includes("file-log is only available") ||
    normalized.includes("file-section-provenance is only available") ||
    normalized.includes("no cwd") ||
    normalized.includes("not a git repository") ||
    normalized.includes("git was not found") ||
    normalized.includes("fatal: bad object")
  ) {
    return 400;
  }

  if (normalized.includes("unknown agent") || normalized.includes("file not found") || normalized.includes("unknown revision")) {
    return 404;
  }

  return 500;
}

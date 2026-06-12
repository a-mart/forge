import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type {
  GitHostedProviderStatus,
  GitPullRequestCheckSummary,
  GitPullRequestDetail,
  GitPullRequestListError,
  GitPullRequestListResult,
  GitPullRequestMergeErrorCode,
  GitPullRequestMergeMethod,
  GitPullRequestMergeResult,
  GitPullRequestState,
  GitPullRequestSummary,
  GitSourceContextRef
} from "@forge/protocol";
import { GitCli } from "../../../versioning/git-cli.js";
import { resolveCurrentBranch } from "../../../versioning/git-source-control-helpers.js";
import type { GitSourceControlContext } from "../shared/route-helpers.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_LIMIT = 50;
const DEFAULT_CLOSED_LIMIT = 10;

const PR_LIST_JSON_FIELDS = [
  "number",
  "title",
  "state",
  "author",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "headRefName",
  "baseRefName",
  "isDraft",
  "url",
  "isCrossRepository",
  "headRepositoryOwner",
  "headRepository",
  "statusCheckRollup",
  "reviewDecision"
].join(",");

const PR_DETAIL_JSON_FIELDS = [
  "number",
  "title",
  "state",
  "author",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "headRefName",
  "baseRefName",
  "isDraft",
  "url",
  "isCrossRepository",
  "headRepositoryOwner",
  "headRepository",
  "body",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "statusCheckRollup",
  "additions",
  "deletions",
  "changedFiles",
  "headRefOid"
].join(",");

const REPO_MERGE_SETTINGS_FIELDS = [
  "mergeCommitAllowed",
  "squashMergeAllowed",
  "rebaseMergeAllowed"
].join(",");

export interface GitHubRepoIdentity {
  owner: string;
  repo: string;
  remoteUrl: string;
}

export interface GitHostedProviderOptions {
  ghBinary?: string;
  timeoutMs?: number;
}

export type GitHostedProviderErrorCode =
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "network"
  | "auth"
  | "permission"
  | "unknown";

export class GitHostedProviderError extends Error {
  readonly httpStatus: number;
  readonly code: GitHostedProviderErrorCode;

  constructor(message: string, httpStatus: number, code: GitHostedProviderErrorCode) {
    super(message);
    this.name = "GitHostedProviderError";
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

interface RawGhAuthor {
  login?: string;
  name?: string;
}

interface RawGhHeadRepositoryOwner {
  login?: string;
}

interface RawGhHeadRepository {
  name?: string;
  owner?: RawGhHeadRepositoryOwner;
}

interface RawGhStatusCheckRollup {
  state?: string;
  status?: string;
  conclusion?: string;
  name?: string;
  detailsUrl?: string;
}

interface RawGhRepoMergeSettings {
  mergeCommitAllowed?: boolean;
  squashMergeAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
}

interface RawGhPullRequest {
  number?: number;
  title?: string;
  state?: string;
  author?: RawGhAuthor | null;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
  headRepositoryOwner?: RawGhHeadRepositoryOwner;
  headRepository?: RawGhHeadRepository;
  url?: string;
  body?: string;
  mergeable?: string | boolean;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: RawGhStatusCheckRollup | RawGhStatusCheckRollup[] | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefOid?: string;
}

type CheckStatus = NonNullable<GitPullRequestSummary["checkStatus"]>;

const CHECK_STATUS_SEVERITY: Record<CheckStatus, number> = {
  failure: 3,
  pending: 2,
  success: 1,
  neutral: 0
};

export class GitHostedProviderService {
  private readonly ghBinary: string;
  private readonly timeoutMs: number;

  constructor(options: GitHostedProviderOptions = {}) {
    this.ghBinary = options.ghBinary ?? "gh";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getProviderStatus(context: GitSourceControlContext): Promise<GitHostedProviderStatus> {
    return this.buildProviderStatus(context);
  }

  async listPullRequests(
    context: GitSourceControlContext,
    options: { openLimit?: number; closedLimit?: number } = {}
  ): Promise<GitPullRequestListResult> {
    const providerStatus = await this.buildProviderStatus(context);
    const baseResult = this.buildListResultShell(context, providerStatus);

    if (context.notInitialized) {
      return {
        ...baseResult,
        notInitialized: true
      };
    }

    if (!providerStatus.available || !providerStatus.authenticated || !providerStatus.remoteUrl) {
      return baseResult;
    }

    const repo = parseGitHubRepoFromRemoteUrl(providerStatus.remoteUrl);
    if (!repo) {
      return {
        ...baseResult,
        providerStatus: {
          ...providerStatus,
          provider: "none",
          available: false,
          message: "Pull requests require a GitHub remote."
        }
      };
    }

    const currentBranch = await resolveCurrentBranch(new GitCli({ cwd: context.cwd }));
    const openLimit = options.openLimit ?? DEFAULT_OPEN_LIMIT;
    const closedLimit = options.closedLimit ?? DEFAULT_CLOSED_LIMIT;

    const [openRaw, closedRaw] = await Promise.all([
      this.runGh([
        "pr",
        "list",
        "--repo",
        `${repo.owner}/${repo.repo}`,
        "--state",
        "open",
        "--limit",
        String(openLimit),
        "--json",
        PR_LIST_JSON_FIELDS
      ]),
      this.runGh([
        "pr",
        "list",
        "--repo",
        `${repo.owner}/${repo.repo}`,
        "--state",
        "closed",
        "--limit",
        String(closedLimit),
        "--json",
        PR_LIST_JSON_FIELDS
      ])
    ]);

    if (openRaw.exitCode !== 0 || closedRaw.exitCode !== 0) {
      const failure = classifyGhFailure(openRaw, closedRaw);
      return {
        ...baseResult,
        listError: toListError(failure),
        providerStatus: {
          ...providerStatus,
          authenticated: failure.code === "auth" ? false : providerStatus.authenticated,
          message: failure.code === "auth" ? failure.message : providerStatus.message
        }
      };
    }

    const open = parseGhPullRequestList(openRaw.stdout, currentBranch, repo);
    const recentlyClosed = parseGhPullRequestList(closedRaw.stdout, currentBranch, repo);
    const currentBranchPullRequest =
      open.find((entry) => entry.isCurrentBranch) ??
      recentlyClosed.find((entry) => entry.isCurrentBranch) ??
      null;

    return {
      ...baseResult,
      open,
      recentlyClosed,
      currentBranchPullRequest,
      listError: null
    };
  }

  async getPullRequestDetail(
    context: GitSourceControlContext,
    number: number
  ): Promise<GitPullRequestDetail | null> {
    const providerStatus = await this.buildProviderStatus(context);
    if (
      context.notInitialized ||
      !providerStatus.available ||
      !providerStatus.authenticated ||
      !providerStatus.remoteUrl
    ) {
      return null;
    }

    const repo = parseGitHubRepoFromRemoteUrl(providerStatus.remoteUrl);
    if (!repo) {
      return null;
    }

    const currentBranch = await resolveCurrentBranch(new GitCli({ cwd: context.cwd }));
    const result = await this.runGh([
      "pr",
      "view",
      String(number),
      "--repo",
      `${repo.owner}/${repo.repo}`,
      "--json",
      PR_DETAIL_JSON_FIELDS
    ]);

    if (result.exitCode !== 0) {
      throw classifyGhFailure(result);
    }

    const parsed = parseGhPullRequestJson(result.stdout);
    if (!parsed) {
      throw new GitHostedProviderError(
        "GitHub pull request response was empty or invalid.",
        502,
        "unknown"
      );
    }

    const summary = toPullRequestSummary(parsed, currentBranch, repo);
    const allowedMergeMethods = await this.resolveAllowedMergeMethods(repo);
    return {
      ...summary,
      body: typeof parsed.body === "string" ? parsed.body : "",
      mergeable: parseMergeable(parsed),
      mergeBlockedReason: parseMergeBlockedReason(parsed),
      checks: parseCheckSummaries(parsed.statusCheckRollup),
      reviewDecision: parsed.reviewDecision ?? null,
      changedFiles: parsed.changedFiles ?? 0,
      additions: parsed.additions ?? 0,
      deletions: parsed.deletions ?? 0,
      headSha: parsed.headRefOid ?? "",
      isForkPullRequest: parsed.isCrossRepository === true,
      allowedMergeMethods
    };
  }

  async mergePullRequest(
    context: GitSourceControlContext,
    number: number,
    request: {
      method: GitPullRequestMergeMethod;
      expectedHeadSha: string;
      deleteBranchAfterMerge?: boolean;
      acknowledgeCheckFailures?: boolean;
    }
  ): Promise<GitPullRequestMergeResult> {
    const providerStatus = await this.buildProviderStatus(context);
    if (
      context.notInitialized ||
      !providerStatus.available ||
      !providerStatus.authenticated ||
      !providerStatus.remoteUrl
    ) {
      return createMergeFailureResult(number, request.method, {
        code: "provider_unavailable",
        message:
          providerStatus.message ??
          "GitHub pull request merge is unavailable for this repository context.",
        errors: [
          providerStatus.message ??
            "Install and authenticate GitHub CLI (`gh auth login`) before merging pull requests."
        ]
      });
    }

    const repo = parseGitHubRepoFromRemoteUrl(providerStatus.remoteUrl);
    if (!repo) {
      return createMergeFailureResult(number, request.method, {
        code: "provider_unavailable",
        message: "Pull request merge requires a GitHub remote.",
        errors: ["Pull request merge requires a GitHub remote."]
      });
    }

    let detail: GitPullRequestDetail;
    try {
      const fetched = await this.getPullRequestDetail(context, number);
      if (!fetched) {
        return createMergeFailureResult(number, request.method, {
          code: "not_found",
          message: "Pull request was not found.",
          errors: ["Pull request was not found."]
        });
      }

      detail = fetched;
    } catch (error) {
      if (error instanceof GitHostedProviderError) {
        return createMergeFailureResult(number, request.method, {
          code: mapProviderErrorToMergeCode(error.code),
          message: error.message,
          errors: [error.message]
        });
      }

      throw error;
    }

    const expectedHeadSha = request.expectedHeadSha.trim();
    if (expectedHeadSha.length === 0) {
      throw new Error("expectedHeadSha must be a non-empty string.");
    }

    const preflight = evaluateMergePreflight(detail, request.method, {
      expectedHeadSha,
      deleteBranchAfterMerge: request.deleteBranchAfterMerge === true,
      acknowledgeCheckFailures: request.acknowledgeCheckFailures === true
    });
    if (!preflight.allowed) {
      return {
        success: false,
        number,
        method: request.method,
        errors: preflight.errors,
        warnings: preflight.warnings,
        errorCode: preflight.errorCode,
        detail,
        invalidateCaches: false
      };
    }

    const mergeArgs = [
      "pr",
      "merge",
      String(number),
      "--repo",
      `${repo.owner}/${repo.repo}`,
      mergeMethodFlag(request.method),
      "--match-head-commit",
      detail.headSha
    ];

    if (request.deleteBranchAfterMerge === true) {
      mergeArgs.push("--delete-branch");
    }

    const mergeResult = await this.runGh(mergeArgs);
    if (mergeResult.exitCode !== 0) {
      const failure = classifyMergeGhFailure(mergeResult);
      return {
        success: false,
        number,
        method: request.method,
        errors: [failure.message],
        warnings: preflight.warnings,
        errorCode: failure.code,
        detail,
        invalidateCaches: false
      };
    }

    let refreshedDetail: GitPullRequestDetail | undefined;
    try {
      refreshedDetail = (await this.getPullRequestDetail(context, number)) ?? undefined;
    } catch {
      refreshedDetail = undefined;
    }

    return {
      success: true,
      number,
      method: request.method,
      mergedAt: refreshedDetail?.mergedAt ?? new Date().toISOString(),
      state: refreshedDetail?.state ?? "merged",
      providerUrl: refreshedDetail?.providerUrl ?? detail.providerUrl,
      branchDeleted: request.deleteBranchAfterMerge === true,
      errors: [],
      warnings: preflight.warnings,
      detail: refreshedDetail ?? {
        ...detail,
        state: "merged",
        mergedAt: detail.mergedAt ?? new Date().toISOString()
      },
      invalidateCaches: true
    };
  }

  private async resolveAllowedMergeMethods(
    repo: GitHubRepoIdentity
  ): Promise<GitPullRequestMergeMethod[]> {
    const result = await this.runGh([
      "repo",
      "view",
      `${repo.owner}/${repo.repo}`,
      "--json",
      REPO_MERGE_SETTINGS_FIELDS
    ]);
    if (result.exitCode !== 0) {
      return ["squash", "merge", "rebase"];
    }

    return parseAllowedMergeMethods(result.stdout);
  }

  private buildListResultShell(
    context: GitSourceControlContext,
    providerStatus: GitHostedProviderStatus
  ): GitPullRequestListResult {
    return {
      open: [],
      recentlyClosed: [],
      currentBranchPullRequest: null,
      providerStatus,
      context: toContextRef(context),
      repoName: basename(context.baseCwd),
      repoRoot: context.baseCwd,
      repoKind: context.repoKind,
      repoLabel: context.repoLabel
    };
  }

  private async buildProviderStatus(context: GitSourceControlContext): Promise<GitHostedProviderStatus> {
    if (context.notInitialized) {
      return {
        provider: "none",
        available: false,
        authenticated: false,
        remoteUrl: null,
        message: "Repository is not initialized."
      };
    }

    const remoteUrl = await resolveOriginRemoteUrl(context.cwd);
    if (!remoteUrl) {
      return {
        provider: "none",
        available: false,
        authenticated: false,
        remoteUrl: null,
        message: "No origin remote is configured for this repository."
      };
    }

    const repo = parseGitHubRepoFromRemoteUrl(remoteUrl);
    if (!repo) {
      return {
        provider: "none",
        available: false,
        authenticated: false,
        remoteUrl,
        message: "Pull requests are only supported for GitHub remotes in this phase."
      };
    }

    const ghVersion = await this.runGh(["--version"]);
    if (ghVersion.exitCode !== 0) {
      return {
        provider: "github",
        available: false,
        authenticated: false,
        remoteUrl,
        message: "Install GitHub CLI (gh) and authenticate to view pull requests."
      };
    }

    const authStatus = await this.runGh(["auth", "status"]);
    if (authStatus.exitCode !== 0) {
      return {
        provider: "github",
        available: true,
        authenticated: false,
        remoteUrl,
        message: "Run `gh auth login` to connect GitHub pull requests."
      };
    }

    return {
      provider: "github",
      available: true,
      authenticated: true,
      remoteUrl
    };
  }

  private async runGh(args: string[]): Promise<GhExecResult> {
    try {
      const result = await execFileAsync(this.ghBinary, args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0
      };
    } catch (error) {
      return normalizeExecError(error);
    }
  }
}

export function parseGitHubRepoFromRemoteUrl(remoteUrl: string): GitHubRepoIdentity | null {
  const trimmed = remoteUrl.trim();
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch) {
    return {
      owner: sshMatch[1]!,
      repo: stripGitSuffix(sshMatch[2]!),
      remoteUrl: trimmed
    };
  }

  const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?(?:\/.*)?$/i.exec(trimmed);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1]!,
      repo: stripGitSuffix(httpsMatch[2]!),
      remoteUrl: trimmed
    };
  }

  return null;
}

export function aggregateCheckStatusFromRollup(
  rollup: RawGhPullRequest["statusCheckRollup"]
): GitPullRequestSummary["checkStatus"] {
  const entries = normalizeRollupEntries(rollup);
  if (entries.length === 0) {
    return null;
  }

  let best: CheckStatus | null = null;
  let bestSeverity = -1;

  for (const entry of entries) {
    const status = classifyCheckEntryStatus(entry);
    if (!status) {
      continue;
    }

    const severity = CHECK_STATUS_SEVERITY[status];
    if (severity > bestSeverity) {
      best = status;
      bestSeverity = severity;
    }
  }

  return best;
}

export function parseCheckSummariesFromRollup(
  rollup: RawGhPullRequest["statusCheckRollup"]
): GitPullRequestCheckSummary[] {
  return parseCheckSummaries(rollup);
}

export function matchesCurrentBranchPullRequest(
  entry: Pick<
    RawGhPullRequest,
    "headRefName" | "isCrossRepository" | "headRepositoryOwner" | "headRepository"
  >,
  currentBranch: string | null,
  originRepo: GitHubRepoIdentity | null
): boolean {
  const normalizedBranch = normalizeBranchName(currentBranch);
  const normalizedHead = normalizeBranchName(entry.headRefName ?? "");
  if (normalizedBranch.length === 0 || normalizedHead.length === 0) {
    return false;
  }

  if (normalizedBranch !== normalizedHead) {
    return false;
  }

  if (entry.isCrossRepository === true) {
    const headOwner =
      entry.headRepositoryOwner?.login?.toLowerCase() ??
      entry.headRepository?.owner?.login?.toLowerCase();
    const headRepo = entry.headRepository?.name?.toLowerCase();
    if (!originRepo || !headOwner || !headRepo) {
      return false;
    }

    return (
      headOwner === originRepo.owner.toLowerCase() &&
      headRepo === originRepo.repo.toLowerCase()
    );
  }

  return true;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

async function resolveOriginRemoteUrl(cwd: string): Promise<string | null> {
  const git = new GitCli({ cwd });
  const result = await git.run(["remote", "get-url", "origin"], { allowFailure: true });
  if (result.exitCode !== 0) {
    return null;
  }

  const remoteUrl = result.stdout.trim();
  return remoteUrl.length > 0 ? remoteUrl : null;
}

function parseGhPullRequestList(
  stdout: string,
  currentBranch: string | null,
  originRepo: GitHubRepoIdentity
): GitPullRequestSummary[] {
  const entries = parseGhPullRequestArray(stdout);
  return entries
    .map((entry) => toPullRequestSummary(entry, currentBranch, originRepo))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function parseGhPullRequestArray(stdout: string): RawGhPullRequest[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is RawGhPullRequest => !!entry && typeof entry === "object");
  } catch {
    return [];
  }
}

function parseGhPullRequestJson(stdout: string): RawGhPullRequest | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed as RawGhPullRequest;
  } catch {
    return null;
  }
}

function toPullRequestSummary(
  entry: RawGhPullRequest,
  currentBranch: string | null,
  originRepo: GitHubRepoIdentity | null
): GitPullRequestSummary {
  const headRef = entry.headRefName ?? "unknown";

  return {
    number: entry.number ?? 0,
    title: entry.title ?? "Untitled pull request",
    state: normalizePullRequestState(entry.state, entry.mergedAt),
    author: entry.author?.login ?? entry.author?.name ?? "unknown",
    createdAt: entry.createdAt ?? "",
    updatedAt: entry.updatedAt ?? entry.closedAt ?? entry.createdAt ?? "",
    closedAt: entry.closedAt ?? null,
    mergedAt: entry.mergedAt ?? null,
    headRef,
    baseRef: entry.baseRefName ?? "unknown",
    isDraft: entry.isDraft === true,
    isCurrentBranch: matchesCurrentBranchPullRequest(entry, currentBranch, originRepo),
    checkStatus: aggregateCheckStatusFromRollup(entry.statusCheckRollup),
    reviewDecision: entry.reviewDecision ?? null,
    providerUrl: entry.url
  };
}

function normalizePullRequestState(
  rawState: string | undefined,
  mergedAt: string | null | undefined
): GitPullRequestState {
  const normalized = (rawState ?? "").toUpperCase();
  if (normalized === "MERGED" || mergedAt) {
    return "merged";
  }

  if (normalized === "CLOSED") {
    return "closed";
  }

  return "open";
}

function normalizeBranchName(branch: string | null): string {
  if (!branch) {
    return "";
  }

  return branch.replace(/^refs\/heads\//, "").trim();
}

function normalizeRollupEntries(
  rollup: RawGhPullRequest["statusCheckRollup"]
): RawGhStatusCheckRollup[] {
  if (!rollup) {
    return [];
  }

  return Array.isArray(rollup) ? rollup : [rollup];
}

function classifyCheckEntryStatus(entry: RawGhStatusCheckRollup): CheckStatus | null {
  const status = (entry.status ?? "").toUpperCase();
  const state = (entry.state ?? "").toUpperCase();
  const conclusion = (entry.conclusion ?? "").toUpperCase();

  if (
    status === "QUEUED" ||
    status === "IN_PROGRESS" ||
    status === "PENDING" ||
    state === "PENDING" ||
    state === "EXPECTED" ||
    state === "REQUESTED"
  ) {
    return "pending";
  }

  if (status === "COMPLETED" || state === "COMPLETED") {
    if (
      conclusion === "FAILURE" ||
      conclusion === "ACTION_REQUIRED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "STARTUP_FAILURE"
    ) {
      return "failure";
    }

    if (conclusion === "SUCCESS") {
      return "success";
    }

    if (conclusion === "NEUTRAL" || conclusion === "SKIPPED" || conclusion === "STALE") {
      return "neutral";
    }
  }

  if (
    state.includes("FAIL") ||
    state.includes("ERROR") ||
    conclusion.includes("FAIL") ||
    conclusion.includes("ERROR")
  ) {
    return "failure";
  }

  if (state.includes("SUCCESS") || conclusion === "SUCCESS") {
    return "success";
  }

  if (state.length > 0 || conclusion.length > 0 || status.length > 0) {
    return "neutral";
  }

  return null;
}

function parseCheckSummaries(
  rollup: RawGhPullRequest["statusCheckRollup"]
): GitPullRequestCheckSummary[] {
  return normalizeRollupEntries(rollup)
    .map((entry, index) => {
      const status = classifyCheckEntryStatus(entry);
      if (!status) {
        return null;
      }

      const name = entry.name?.trim() || `Check ${index + 1}`;
      const summary: GitPullRequestCheckSummary = {
        name,
        status
      };

      if (entry.detailsUrl && entry.detailsUrl.trim().length > 0) {
        summary.url = entry.detailsUrl.trim();
      }

      return summary;
    })
    .filter((entry): entry is GitPullRequestCheckSummary => entry !== null);
}

function parseMergeable(entry: RawGhPullRequest): boolean | null {
  if (typeof entry.mergeable === "boolean") {
    return entry.mergeable;
  }

  if (typeof entry.mergeable === "string") {
    if (entry.mergeable.toUpperCase() === "MERGEABLE") {
      return true;
    }

    if (entry.mergeable.toUpperCase() === "CONFLICTING") {
      return false;
    }
  }

  return null;
}

function parseMergeBlockedReason(entry: RawGhPullRequest): string | undefined {
  if (entry.mergeStateStatus && entry.mergeStateStatus !== "CLEAN" && entry.mergeStateStatus !== "UNKNOWN") {
    return entry.mergeStateStatus.replace(/_/g, " ").toLowerCase();
  }

  if (entry.isDraft) {
    return "Draft pull requests cannot be merged.";
  }

  return undefined;
}

export function classifyGhFailure(...results: GhExecResult[]): GitHostedProviderError {
  for (const result of results) {
    if (result.exitCode === 0 && !result.timedOut) {
      continue;
    }

    if (result.timedOut) {
      return new GitHostedProviderError("GitHub CLI request timed out.", 504, "timeout");
    }

    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const combined = stderr || stdout;
    if (combined.length === 0) {
      continue;
    }

    const normalized = combined.toLowerCase();

    if (normalized.includes("timed out") || normalized.includes("timeout")) {
      return new GitHostedProviderError("GitHub CLI request timed out.", 504, "timeout");
    }

    if (normalized.includes("rate limit") || normalized.includes("api rate limit")) {
      return new GitHostedProviderError("GitHub rate limit reached. Try again later.", 429, "rate_limit");
    }

    if (
      normalized.includes("not found") ||
      normalized.includes("could not resolve") ||
      normalized.includes("no pull requests found") ||
      normalized.includes("pull request not found")
    ) {
      return new GitHostedProviderError("GitHub repository or pull request was not found.", 404, "not_found");
    }

    if (
      normalized.includes("not logged in") ||
      normalized.includes("authentication") ||
      normalized.includes("bad credentials") ||
      normalized.includes("401")
    ) {
      return new GitHostedProviderError("Run `gh auth login` to connect GitHub pull requests.", 401, "auth");
    }

    if (
      normalized.includes("permission denied") ||
      normalized.includes("forbidden") ||
      normalized.includes("403")
    ) {
      return new GitHostedProviderError("GitHub denied access to this pull request.", 403, "permission");
    }

    if (
      normalized.includes("network") ||
      normalized.includes("econnrefused") ||
      normalized.includes("enotfound") ||
      normalized.includes("connection reset") ||
      normalized.includes("temporarily unavailable")
    ) {
      return new GitHostedProviderError("GitHub is temporarily unavailable.", 503, "network");
    }

    return new GitHostedProviderError(combined.split("\n")[0] ?? combined, 502, "unknown");
  }

  return new GitHostedProviderError("GitHub pull request request failed.", 502, "unknown");
}

function toListError(failure: GitHostedProviderError): GitPullRequestListError {
  return {
    code: failure.code,
    message: failure.message
  };
}

function normalizeExecError(error: unknown): GhExecResult {
  if (!error || typeof error !== "object") {
    return {
      stdout: "",
      stderr: "Unknown gh execution failure.",
      exitCode: 1
    };
  }

  const record = error as NodeJS.ErrnoException & {
    stdout?: string;
    stderr?: string;
    code?: string | number;
    status?: number;
    killed?: boolean;
    signal?: string;
  };

  const timedOut = record.code === "ETIMEDOUT" || record.killed === true;
  const stderr =
    typeof record.stderr === "string"
      ? record.stderr
      : timedOut
        ? "gh command timed out."
        : record.message ?? "gh command failed.";

  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr,
    exitCode: typeof record.status === "number" ? record.status : 1,
    timedOut
  };
}

function toContextRef(context: GitSourceControlContext): GitSourceContextRef {
  return {
    repoTarget: context.repoTarget,
    worktreeId: context.worktreeId
  };
}

export interface MergePreflightEvaluation {
  allowed: boolean;
  errors: string[];
  warnings: string[];
  errorCode?: GitPullRequestMergeErrorCode;
}

export function evaluateMergePreflight(
  detail: GitPullRequestDetail,
  method: GitPullRequestMergeMethod,
  options: {
    expectedHeadSha: string;
    deleteBranchAfterMerge: boolean;
    acknowledgeCheckFailures: boolean;
  }
): MergePreflightEvaluation {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (detail.state !== "open") {
    return {
      allowed: false,
      errors: [`Pull request #${detail.number} is ${detail.state} and cannot be merged.`],
      warnings,
      errorCode: "closed"
    };
  }

  if (detail.isDraft) {
    return {
      allowed: false,
      errors: ["Draft pull requests cannot be merged."],
      warnings,
      errorCode: "draft"
    };
  }

  if (detail.headSha.trim().length === 0) {
    return {
      allowed: false,
      errors: ["Pull request head commit is unavailable. Refresh and try again."],
      warnings,
      errorCode: "unknown"
    };
  }

  if (detail.headSha !== options.expectedHeadSha.trim()) {
    return {
      allowed: false,
      errors: [
        "Pull request head commit changed since you opened merge confirmation. Refresh and try again."
      ],
      warnings,
      errorCode: "stale_head"
    };
  }

  if (detail.mergeable === false) {
    return {
      allowed: false,
      errors: [
        detail.mergeBlockedReason
          ? `Pull request is not mergeable: ${detail.mergeBlockedReason}.`
          : "Pull request is not mergeable."
      ],
      warnings,
      errorCode: "not_mergeable"
    };
  }

  const allowedMethods = detail.allowedMergeMethods ?? ["squash", "merge", "rebase"];
  if (!allowedMethods.includes(method)) {
    return {
      allowed: false,
      errors: [`Merge method "${method}" is not allowed for this repository.`],
      warnings,
      errorCode: "method_not_allowed"
    };
  }

  if (options.deleteBranchAfterMerge && detail.isForkPullRequest) {
    return {
      allowed: false,
      errors: ["Deleting the head branch is not supported for fork pull requests."],
      warnings,
      errorCode: "branch_delete_unsafe"
    };
  }

  if (detail.checkStatus === "failure" && !options.acknowledgeCheckFailures) {
    return {
      allowed: false,
      errors: ["Checks are failing. Review the check summary or confirm merge anyway if GitHub policy allows."],
      warnings,
      errorCode: "checks_blocked"
    };
  }

  if (detail.checkStatus === "pending" && !options.acknowledgeCheckFailures) {
    return {
      allowed: false,
      errors: ["Checks are still pending. Wait for completion or confirm merge anyway if GitHub policy allows."],
      warnings,
      errorCode: "checks_pending"
    };
  }

  if (detail.checkStatus === "failure" && options.acknowledgeCheckFailures) {
    warnings.push("Proceeding despite failing checks. GitHub branch protection may still block the merge.");
  }

  if (detail.checkStatus === "pending" && options.acknowledgeCheckFailures) {
    warnings.push("Proceeding while checks are pending. GitHub branch protection may still block the merge.");
  }

  if (detail.mergeBlockedReason) {
    warnings.push(`GitHub reports merge state: ${detail.mergeBlockedReason}.`);
  }

  return {
    allowed: true,
    errors,
    warnings
  };
}

export function parseAllowedMergeMethods(stdout: string): GitPullRequestMergeMethod[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return ["squash", "merge", "rebase"];
  }

  try {
    const parsed = JSON.parse(trimmed) as RawGhRepoMergeSettings;
    const methods: GitPullRequestMergeMethod[] = [];
    if (parsed.squashMergeAllowed !== false) {
      methods.push("squash");
    }
    if (parsed.mergeCommitAllowed !== false) {
      methods.push("merge");
    }
    if (parsed.rebaseMergeAllowed !== false) {
      methods.push("rebase");
    }

    return methods.length > 0 ? methods : ["squash", "merge", "rebase"];
  } catch {
    return ["squash", "merge", "rebase"];
  }
}

export function classifyMergeGhFailure(result: GhExecResult): {
  code: GitPullRequestMergeErrorCode;
  message: string;
} {
  const providerError = classifyGhFailure(result);
  const normalized = `${result.stderr}\n${result.stdout}`.toLowerCase();

  if (
    normalized.includes("head branch was modified") ||
    normalized.includes("head branch is out of date") ||
    normalized.includes("match-head-commit")
  ) {
    return {
      code: "stale_head",
      message: "Pull request head commit changed before merge completed. Refresh and try again."
    };
  }

  if (
    normalized.includes("required status check") ||
    normalized.includes("checks have not passed") ||
    normalized.includes("review required")
  ) {
    return {
      code: "checks_blocked",
      message: providerError.message
    };
  }

  if (normalized.includes("not mergeable") || normalized.includes("merge conflict")) {
    return {
      code: "not_mergeable",
      message: providerError.message
    };
  }

  if (normalized.includes("squash merge") && normalized.includes("not allowed")) {
    return {
      code: "method_not_allowed",
      message: providerError.message
    };
  }

  if (normalized.includes("merge commit") && normalized.includes("not allowed")) {
    return {
      code: "method_not_allowed",
      message: providerError.message
    };
  }

  if (normalized.includes("rebase merge") && normalized.includes("not allowed")) {
    return {
      code: "method_not_allowed",
      message: providerError.message
    };
  }

  return {
    code: mapProviderErrorToMergeCode(providerError.code),
    message: providerError.message
  };
}

function mergeMethodFlag(method: GitPullRequestMergeMethod): string {
  if (method === "squash") {
    return "--squash";
  }

  if (method === "rebase") {
    return "--rebase";
  }

  return "--merge";
}

function mapProviderErrorToMergeCode(
  code: GitHostedProviderErrorCode
): GitPullRequestMergeErrorCode {
  if (code === "not_found") {
    return "not_found";
  }
  if (code === "auth") {
    return "auth";
  }
  if (code === "permission") {
    return "permission";
  }
  if (code === "rate_limit") {
    return "rate_limit";
  }
  if (code === "timeout") {
    return "timeout";
  }
  if (code === "network") {
    return "network";
  }

  return "unknown";
}

function createMergeFailureResult(
  number: number,
  method: GitPullRequestMergeMethod,
  options: {
    code: GitPullRequestMergeErrorCode;
    message: string;
    errors: string[];
  }
): GitPullRequestMergeResult {
  return {
    success: false,
    number,
    method,
    errors: options.errors,
    warnings: [],
    errorCode: options.code,
    invalidateCaches: false
  };
}

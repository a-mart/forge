import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type {
  GitHostedProviderStatus,
  GitPullRequestCheckSummary,
  GitPullRequestDetail,
  GitPullRequestListResult,
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

export interface GitHubRepoIdentity {
  owner: string;
  repo: string;
  remoteUrl: string;
}

export interface GitHostedProviderOptions {
  ghBinary?: string;
  timeoutMs?: number;
}

interface GhExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RawGhAuthor {
  login?: string;
  name?: string;
}

interface RawGhStatusCheckRollup {
  state?: string;
  status?: string;
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
      const message = normalizeGhFailureMessage(openRaw, closedRaw);
      return {
        ...baseResult,
        providerStatus: {
          ...providerStatus,
          available: true,
          authenticated: false,
          message
        }
      };
    }

    const open = parseGhPullRequestList(openRaw.stdout, currentBranch);
    const recentlyClosed = parseGhPullRequestList(closedRaw.stdout, currentBranch);
    const currentBranchPullRequest =
      open.find((entry) => entry.isCurrentBranch) ??
      recentlyClosed.find((entry) => entry.isCurrentBranch) ??
      null;

    return {
      ...baseResult,
      open,
      recentlyClosed,
      currentBranchPullRequest
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
      throw new Error(normalizeGhFailureMessage(result));
    }

    const parsed = parseGhPullRequestJson(result.stdout);
    if (!parsed) {
      return null;
    }

    const summary = toPullRequestSummary(parsed, currentBranch);
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
      headSha: parsed.headRefOid ?? ""
    };
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
      const normalized = normalizeExecError(error);
      return normalized;
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

function parseGhPullRequestList(stdout: string, currentBranch: string | null): GitPullRequestSummary[] {
  const entries = parseGhPullRequestArray(stdout);
  return entries
    .map((entry) => toPullRequestSummary(entry, currentBranch))
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
  currentBranch: string | null
): GitPullRequestSummary {
  const headRef = entry.headRefName ?? "unknown";
  const normalizedBranch = normalizeBranchName(currentBranch);
  const normalizedHead = normalizeBranchName(headRef);

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
    isCurrentBranch:
      normalizedBranch.length > 0 &&
      normalizedHead.length > 0 &&
      normalizedBranch === normalizedHead,
    checkStatus: normalizeCheckStatus(entry.statusCheckRollup),
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

function normalizeCheckStatus(
  rollup: RawGhPullRequest["statusCheckRollup"]
): GitPullRequestSummary["checkStatus"] {
  const state = extractRollupState(rollup);
  if (!state) {
    return null;
  }

  const normalized = state.toUpperCase();
  if (normalized.includes("PENDING") || normalized.includes("IN_PROGRESS") || normalized === "QUEUED") {
    return "pending";
  }

  if (normalized.includes("FAIL") || normalized.includes("ERROR")) {
    return "failure";
  }

  if (normalized.includes("SUCCESS") || normalized === "COMPLETED") {
    return "success";
  }

  return "neutral";
}

function extractRollupState(
  rollup: RawGhPullRequest["statusCheckRollup"]
): string | null {
  if (!rollup) {
    return null;
  }

  if (Array.isArray(rollup)) {
    return rollup.map((entry) => entry.state ?? entry.status ?? "").find(Boolean) ?? null;
  }

  return rollup.state ?? rollup.status ?? null;
}

function parseCheckSummaries(
  rollup: RawGhPullRequest["statusCheckRollup"]
): GitPullRequestCheckSummary[] {
  if (!rollup) {
    return [];
  }

  const entries = Array.isArray(rollup) ? rollup : [rollup];
  return entries
    .map((entry, index) => {
      const status = normalizeCheckStatus(entry);
      if (!status) {
        return null;
      }

      return {
        name: entry.state ?? entry.status ?? `Check ${index + 1}`,
        status
      } satisfies GitPullRequestCheckSummary;
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

function normalizeGhFailureMessage(...results: GhExecResult[]): string {
  for (const result of results) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const combined = stderr || stdout;
    if (combined.length === 0) {
      continue;
    }

    const normalized = combined.toLowerCase();
    if (normalized.includes("not logged in") || normalized.includes("auth")) {
      return "Run `gh auth login` to connect GitHub pull requests.";
    }

    if (normalized.includes("rate limit")) {
      return "GitHub rate limit reached. Try again later.";
    }

    if (normalized.includes("could not resolve") || normalized.includes("not found")) {
      return "GitHub repository or pull request was not found.";
    }

    return combined.split("\n")[0] ?? combined;
  }

  return "GitHub pull request request failed.";
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
  };

  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr:
      typeof record.stderr === "string"
        ? record.stderr
        : record.code === "ETIMEDOUT"
          ? "gh command timed out."
          : record.message ?? "gh command failed.",
    exitCode: typeof record.status === "number" ? record.status : 1
  };
}

function toContextRef(context: GitSourceControlContext): GitSourceContextRef {
  return {
    repoTarget: context.repoTarget,
    worktreeId: context.worktreeId
  };
}

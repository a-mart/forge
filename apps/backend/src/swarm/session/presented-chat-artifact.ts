import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";
import MarkdownIt from "markdown-it";
import { isUserVisibleAssistantConversationMessage } from "@forge/protocol";
import type { AgentDescriptor } from "../types.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "./conversation-timeline.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import { backfillConversationMessageEntryId } from "./conversation-entry-id.js";
import { MAX_SESSION_FILE_BYTES_FOR_OPEN } from "./session-file-guard.js";
import { MAX_READ_FILE_CONTENT_BYTES, resolveEffectiveAgentWorkspaceCwd } from "../../ws/ws-file-access.js";
import { resolveReadFileContentType } from "../../ws/http-utils.js";
import { GitCli } from "../../versioning/git-cli.js";
import { parseWorktreeListPorcelain, resolveGitCommonDirectory } from "../../versioning/git-source-control-helpers.js";

// Keep document reads aligned with the existing 2 MiB text/file-reader budget. Image previews get
// a separate 4 MiB raw-byte budget; their base64 JSON representation is therefore bounded to ~5.34 MiB.
export const MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES = MAX_READ_FILE_CONTENT_BYTES;

export type ChatArtifactErrorCode = "invalid_request" | "invalid_path" | "invalid_transcript_owner" | "transcript_not_found" | "transcript_too_large" | "corrupt_transcript" | "transcript_read_failed" | "message_not_found" | "ambiguous_message_id" | "ineligible_message" | "path_not_presented" | "path_outside_workspace" | "file_not_found" | "unsafe_file_identity" | "file_identity_changed" | "file_too_large" | "stable_identity_unsupported";
export class ChatArtifactError extends Error { constructor(public readonly code: ChatArtifactErrorCode) { super(code); } }
const fail = (code: ChatArtifactErrorCode): never => { throw new ChatArtifactError(code); };
const hasControl = (value: string) => /[\0-\x1f\x7f]/.test(value);
const markdown = new MarkdownIt({ typographer: true, linkify: true });
markdown.inline.ruler.before("link", "artifact_shortcode", (state, silent) => {
  if (((state as typeof state & { linkLevel?: number }).linkLevel ?? 0) > 0) return false;
  const match = /^\[artifact:([^\]\n]+)\]/i.exec(state.src.slice(state.pos));
  const rawPath = match?.[1]?.trim();
  if (!match || !rawPath) return false;
  let href: string;
  try {
    const encodedPath = encodeURI(rawPath);
    href = /^[A-Za-z]:[\\/]/.test(rawPath)
      ? `swarm-file:///${encodedPath}`
      : `swarm-file://${encodedPath}`;
  } catch {
    return false;
  }
  if (!silent) {
    const openToken = state.push("link_open", "a", 1);
    openToken.attrSet("href", href);
    const textToken = state.push("text", "", 0);
    textToken.content = match[0];
    state.push("link_close", "a", -1);
  }
  state.pos += match[0].length;
  return true;
});

/** Canonical native absolute path. Body values are application data: never decode them here. */
export function canonicalizeChatArtifactPathForPlatform(value: string, platform: NodeJS.Platform = process.platform): string {
  const input = value.trim();
  if (!input || hasControl(input) || /\$\{|\{\{/.test(input) || input === "…") fail("invalid_path");
  if (platform === "win32") {
    if (/^(?:\\\\|\/\/|\\\\[?.]|\\\\\.)/.test(input)) fail("invalid_path");
    const nativeInput = /^\/[A-Za-z]:[\\/]/.test(input) ? input.slice(1) : input;
    if (/^[A-Za-z]:[^\\/]/.test(nativeInput) || nativeInput.slice(2).includes(":")) fail("invalid_path");
    if (!/^[A-Za-z]:[\\/]/.test(nativeInput)) fail("invalid_path");
    const normalized = path.win32.normalize(nativeInput).replace(/\\/g, "/");
    if (!/^[A-Za-z]:\//.test(normalized)) fail("invalid_path");
    return normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) fail("invalid_path");
  const normalized = path.posix.normalize(input);
  // Darwin exposes /tmp as a system-owned alias of /private/tmp. Normalize only this
  // trusted alias before authorization and the no-symlink walk; never generic-realpath claims.
  if (platform === "darwin" && (normalized === "/tmp" || normalized.startsWith("/tmp/"))) {
    return `/private${normalized}`;
  }
  return normalized;
}
export function canonicalizeChatArtifactPath(value: string): string { return canonicalizeChatArtifactPathForPlatform(value); }

/** Convert a href emitted by the mobile Markdown-It configuration with exactly one URI decode. */
export function canonicalizePresentedLinkHrefForPlatform(href: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let raw: string;
  if (href.startsWith("swarm-file://")) {
    raw = href.slice("swarm-file://".length);
    const suffix = raw.search(/[?#]/); if (suffix >= 0) raw = raw.slice(0, suffix);
    if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  } else {
    // markdown-it percent-encodes native Windows backslashes. Recognize native drive paths before URL schemes.
    const nativeWindowsDrive = /^[A-Za-z]:(?:[\\/]|%5c|%5C)/.test(href);
    if (!nativeWindowsDrive && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//"))) return undefined;
    raw = href;
  }
  try { raw = decodeURIComponent(raw); } catch { return undefined; }
  if (hasControl(raw)) return undefined;
  try { return canonicalizeChatArtifactPathForPlatform(raw, platform); } catch { return undefined; }
}
export function canonicalizePresentedLinkHref(href: string): string | undefined { return canonicalizePresentedLinkHrefForPlatform(href); }

/** Authority is derived from rendered links and supported prose shortcodes, never code or images. */
export function extractPresentedArtifactPathsForPlatform(markdownSource: string, platform: NodeJS.Platform = process.platform): string[] {
  const values: string[] = [];
  for (const block of markdown.parse(markdownSource, {})) {
    const tokens = block.type === "inline" ? block.children ?? [] : [block];
    for (const token of tokens) {
      if (token.type !== "link_open" || token.tag !== "a") continue;
      const href = token.attrGet("href");
      if (!href) continue;
      const canonical = canonicalizePresentedLinkHrefForPlatform(href, platform);
      if (canonical) values.push(canonical);
    }
  }
  return values;
}
export function extractPresentedArtifactPaths(markdownSource: string): string[] { return extractPresentedArtifactPathsForPlatform(markdownSource); }

function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform) { return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }

export interface PresentedArtifactTargetResolutionHooks {
  /** Test-only path-semantics seam; production always uses the host platform. */
  platform?: NodeJS.Platform;
  realpath?: (target: string) => Promise<string>;
  listRegisteredWorktrees?: (cwd: string) => Promise<Array<{ path: string; isPrunable: boolean; isBare?: boolean }>>;
  resolveGitRepositoryIdentity?: (canonicalCwd: string) => Promise<string | undefined>;
}

export interface PresentedArtifactWorkspaceSnapshot {
  transcriptCwd: string;
  effectiveProjectCwd: string;
}

async function listRegisteredWorktrees(cwd: string) {
  const result = await new GitCli({ cwd }).run(["worktree", "list", "--porcelain", "-z"], { allowFailure: true });
  return result.exitCode === 0 ? parseWorktreeListPorcelain(result.stdout) : [];
}

async function resolveGitRepositoryIdentity(canonicalCwd: string): Promise<string | undefined> {
  return (await resolveGitCommonDirectory(new GitCli({ cwd: canonicalCwd }), canonicalCwd)) ?? undefined;
}

function isCanonicalPathWithinRoot(target: string, root: string, platform: NodeJS.Platform): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const relative = api.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

/**
 * Resolve a transcript-presented target against server-derived file-browser project context.
 * The request cannot select a source owner or worktree: Git registration is discovered from the
 * effective CWD, and every root and the target are canonicalized before containment is checked.
 */
export async function resolveCanonicalPresentedArtifactTarget(
  workspace: PresentedArtifactWorkspaceSnapshot,
  target: string,
  hooks: PresentedArtifactTargetResolutionHooks = {},
): Promise<string> {
  const platform = hooks.platform ?? process.platform;
  const resolveRealpath = hooks.realpath ?? (async (value: string) => realpath(value));
  const resolveRepositoryIdentity = hooks.resolveGitRepositoryIdentity ?? resolveGitRepositoryIdentity;

  const canonicalTarget = await (async () => {
    try { return canonicalizeChatArtifactPathForPlatform(await resolveRealpath(target), platform); }
    catch (error: unknown) {
      if ((error as { code?: string })?.code === "ENOENT") fail("file_not_found");
      if (error instanceof ChatArtifactError) throw error;
      return fail("transcript_read_failed");
    }
  })();

  const roots: string[] = [];
  const resolveAccessibleRoot = async (candidate: string): Promise<string | undefined> => {
    try { return canonicalizeChatArtifactPathForPlatform(await resolveRealpath(candidate), platform); }
    catch { return undefined; }
  };
  const addRoot = (canonicalRoot: string | undefined) => {
    if (canonicalRoot && !roots.some(root => samePath(root, canonicalRoot, platform))) roots.push(canonicalRoot);
  };
  const canonicalTranscriptCwd = await resolveAccessibleRoot(workspace.transcriptCwd);
  const canonicalEffectiveCwd = await resolveAccessibleRoot(workspace.effectiveProjectCwd);
  addRoot(canonicalTranscriptCwd);
  addRoot(canonicalEffectiveCwd);

  if (canonicalEffectiveCwd) {
    const expectedRepositoryIdentity = await resolveRepositoryIdentity(canonicalEffectiveCwd).catch(() => undefined);
    const worktrees = await (hooks.listRegisteredWorktrees ?? listRegisteredWorktrees)(canonicalEffectiveCwd).catch(() => []);
    for (const worktree of worktrees) {
      if (!expectedRepositoryIdentity || worktree.isPrunable || worktree.isBare) continue;
      const canonicalRoot = await resolveAccessibleRoot(worktree.path);
      if (!canonicalRoot) continue;
      const candidateRepositoryIdentity = await resolveRepositoryIdentity(canonicalRoot).catch(() => undefined);
      if (!candidateRepositoryIdentity || !samePath(candidateRepositoryIdentity, expectedRepositoryIdentity, platform)) continue;
      addRoot(canonicalRoot);
    }
  }

  if (!roots.some(root => isCanonicalPathWithinRoot(canonicalTarget, root, platform))) fail("path_outside_workspace");
  return canonicalTarget;
}
type StableStat = { dev: number | bigint; ino: number | bigint; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
export function stableFileIdentity(stat: StableStat) {
  const usable = (v: number | bigint) => typeof v === "bigint" ? v > 0n : Number.isSafeInteger(v) && v > 0;
  if (!usable(stat.dev) || !usable(stat.ino)) fail("stable_identity_unsupported");
  return `${String(stat.dev)}:${String(stat.ino)}:${stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o"}`;
}
async function statBigint(target: string) { return lstat(target, { bigint: true }); }
async function walkFile(target: string, stage: "initial" | "post"): Promise<{ ids: string[]; finalId: string; finalSize: bigint; real: string }> {
  const api = process.platform === "win32" ? path.win32 : path;
  const parsed = api.parse(target);
  const relative = target.slice(parsed.root.length).split(process.platform === "win32" ? /[\\/]/ : "/").filter(Boolean);
  let current = parsed.root; const ids: string[] = []; let finalSize = 0n;
  for (let i = 0; i < relative.length; i++) {
    current = api.join(current, relative[i]!);
    let s!: Awaited<ReturnType<typeof statBigint>>;
    try { s = await statBigint(current); } catch (error: unknown) {
      if ((error as { code?: string })?.code === "ENOENT") fail(stage === "initial" ? "file_not_found" : "file_identity_changed");
      fail(stage === "initial" ? "transcript_read_failed" : "file_identity_changed");
    }
    if (s.isSymbolicLink()) fail("unsafe_file_identity");
    const id = stableFileIdentity(s);
    if (i < relative.length - 1 && !s.isDirectory()) fail(stage === "initial" ? "invalid_path" : "file_identity_changed");
    if (i === relative.length - 1 && !s.isFile()) fail(stage === "initial" ? "invalid_path" : "file_identity_changed");
    if (i === relative.length - 1) finalSize = s.size;
    ids.push(id);
  }
  let resolved!: string;
  try { resolved = canonicalizeChatArtifactPath(await realpath(target)); } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") fail(stage === "initial" ? "file_not_found" : "file_identity_changed");
    fail(stage === "initial" ? "transcript_read_failed" : "file_identity_changed");
  }
  if (!samePath(resolved, target)) fail("unsafe_file_identity");
  return { ids, finalId: ids.at(-1)!, finalSize, real: resolved };
}

export async function securelyReadPresentedArtifact(target: string, hooks?: { afterInitialWalk?: () => Promise<void> | void; afterOpen?: () => Promise<void> | void; platform?: NodeJS.Platform }) {
  const contentType = resolveReadFileContentType(target);
  const maxBytes = contentType.startsWith("image/")
    ? MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES
    : MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES;
  const initial = await walkFile(target, "initial");
  await hooks?.afterInitialWalk?.();
  const platform = hooks?.platform ?? process.platform;
  // POSIX retains the kernel no-follow guarantee. Windows lacks O_NOFOLLOW, so it opens a handle
  // without reading and then proves that handle has the identity captured by the no-symlink walk.
  if (platform !== "win32" && (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0)) fail("stable_identity_unsupported");
  const openFlags = platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try { handle = await open(target, openFlags); } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT") fail("file_identity_changed");
    if (code === "ELOOP") fail("unsafe_file_identity");
    fail("transcript_read_failed");
  }
  const openedHandle = handle!;
  try {
    const verifyHandle = async () => {
      const checked = await openedHandle.stat({ bigint: true }).catch(() => fail("transcript_read_failed"));
      if (!checked.isFile() || stableFileIdentity(checked) !== initial.finalId) fail("file_identity_changed");
      if (checked.size > BigInt(maxBytes)) fail("file_too_large");
      if (checked.size !== initial.finalSize) fail("file_identity_changed");
      return checked;
    };
    await verifyHandle();
    await hooks?.afterOpen?.();
    const opened = await verifyHandle();
    const verifyPath = async () => {
      const post = await walkFile(target, "post");
      if (post.real !== initial.real || post.ids.length !== initial.ids.length || post.ids.some((id, i) => id !== initial.ids[i]) || post.finalId !== stableFileIdentity(opened)) fail("file_identity_changed");
      if (post.finalSize > BigInt(maxBytes)) fail("file_too_large");
      if (post.finalSize !== initial.finalSize) fail("file_identity_changed");
    };
    await verifyPath();
    const buffer = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < buffer.length) {
      let bytesRead = 0;
      try { ({ bytesRead } = await openedHandle.read(buffer, offset, buffer.length - offset, offset)); } catch { fail("transcript_read_failed"); }
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) fail("file_too_large");
    await verifyHandle();
    await verifyPath();
    const content = buffer.subarray(0, offset);
    const binary = contentType.startsWith("image/") || content.subarray(0, 4000).some((b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13));
    return binary ? { path: target, binary: true, encoding: "base64", contentType, content: content.toString("base64") } : { path: target, content: content.toString("utf8"), contentType };
  } finally { await openedHandle.close(); }
}

export interface PresentedArtifactOwnerSource { getAgent(id: string): AgentDescriptor | undefined; listProfiles(): Array<{ profileId: string; archivedAt?: string }>; getConfig(): { paths: { dataDir: string } }; }
export function resolveActiveBuilderTranscriptDescriptor(source: PresentedArtifactOwnerSource, id: string): AgentDescriptor {
  const descriptor = source.getAgent(id); const dataDir = source.getConfig().paths.dataDir;
  const profiles = new Map(source.listProfiles().map(p => [p.profileId, p]));
  const isManager = (d: AgentDescriptor | undefined): boolean => {
    if (!d || d.role !== "manager" || d.managerId !== d.agentId || d.archivedAt || d.sessionSurface === "collab" || d.collab || d.externalThread || !d.profileId) return false;
    const profile = profiles.get(d.profileId);
    return Boolean(profile && !profile.archivedAt && samePath(path.normalize(d.sessionFile), path.normalize(getSessionFilePath(dataDir, d.profileId, d.agentId))));
  };
  if (isManager(descriptor)) return descriptor!;
  if (!descriptor) fail("invalid_transcript_owner");
  const worker = descriptor!;
  if (worker.role !== "worker" || worker.archivedAt || worker.collab || worker.sessionSurface === "collab" || worker.externalThread || worker.internalWorkerKind) fail("invalid_transcript_owner");
  const owner = source.getAgent(worker.managerId);
  if (!owner || !isManager(owner) || (worker.profileId && worker.profileId !== owner.profileId) || !samePath(path.normalize(worker.sessionFile), path.normalize(getWorkerSessionFilePath(dataDir, owner.profileId!, owner.agentId, worker.agentId)))) fail("invalid_transcript_owner");
  return worker;
}

export async function findUniquePresentedConversationMessage(
  sessionFile: string,
  messageId: string,
  hooks?: { afterOpen?: () => Promise<void> | void },
) {
  if (!messageId.trim()) fail("invalid_request"); let handle: Awaited<ReturnType<typeof open>> | undefined;
  try { handle = await open(sessionFile, fsConstants.O_RDONLY); } catch (error: unknown) { if ((error as { code?: string })?.code === "ENOENT") fail("transcript_not_found"); fail("transcript_read_failed"); }
  const openedHandle = handle!;
  try {
    const s = await openedHandle.stat().catch(() => fail("transcript_read_failed"));
    await hooks?.afterOpen?.();
    if (s.size > MAX_SESSION_FILE_BYTES_FOR_OPEN) fail("transcript_too_large");
    let carry = "", total = 0; const found: any[] = []; const buf = Buffer.alloc(64 * 1024); const decoder = new StringDecoder("utf8");
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let wrapper: unknown; try { wrapper = JSON.parse(line); } catch { fail("corrupt_transcript"); }
      if (!wrapper || typeof wrapper !== "object" || (wrapper as { type?: unknown }).type !== "custom" || (wrapper as { customType?: unknown }).customType !== CONVERSATION_ENTRY_TYPE) return;
      const data = (wrapper as { data?: unknown }).data;
      // A conversation wrapper with malformed data is canonical transcript corruption, never an authorization candidate.
      if (data && typeof data === "object" && (data as { type?: unknown }).type === "conversation_message" && !isConversationEntryEvent(data)) fail("corrupt_transcript");
      if (!isConversationEntryEvent(data) || data.type !== "conversation_message") return;
      const hydrated = backfillConversationMessageEntryId(data, (wrapper as { id?: unknown }).id);
      if (hydrated.type === "conversation_message" && hydrated.id === messageId) found.push(hydrated);
    };
    for (;;) {
      let bytesRead = 0;
      try { ({ bytesRead } = await openedHandle.read(buf, 0, buf.length, null)); } catch { fail("transcript_read_failed"); }
      if (!bytesRead) break;
      total += bytesRead; if (total > MAX_SESSION_FILE_BYTES_FOR_OPEN) fail("transcript_too_large");
      carry += decoder.write(buf.subarray(0, bytesRead)); const lines = carry.split("\n"); carry = lines.pop()!; for (const line of lines) processLine(line);
    }
    carry += decoder.end(); if (carry.trim()) processLine(carry);
    if (!found.length) fail("message_not_found"); if (found.length !== 1) fail("ambiguous_message_id"); return found[0];
  } finally { await openedHandle.close(); }
}

export async function readPresentedChatArtifact(
  source: PresentedArtifactOwnerSource,
  claim: { transcriptAgentId: unknown; messageId: unknown; path: unknown },
  options?: {
    securityPlatform?: NodeJS.Platform;
    targetResolution?: PresentedArtifactTargetResolutionHooks;
    transcriptRead?: { afterOpen?: () => Promise<void> | void };
  },
) {
  const raw = claim as { transcriptAgentId?: unknown; messageId?: unknown; path?: unknown };
  if (
    Object.keys(raw).some(key => key !== "transcriptAgentId" && key !== "messageId" && key !== "path") ||
    typeof raw.transcriptAgentId !== "string" ||
    typeof raw.messageId !== "string" ||
    typeof raw.path !== "string"
  ) fail("invalid_request");
  const pathValue = raw.path as string; const transcriptAgentId = raw.transcriptAgentId as string; const messageId = raw.messageId as string;
  const target = canonicalizeChatArtifactPath(pathValue); const descriptor = resolveActiveBuilderTranscriptDescriptor(source, transcriptAgentId.trim());
  const workspace: PresentedArtifactWorkspaceSnapshot = {
    transcriptCwd: descriptor.cwd,
    effectiveProjectCwd: (() => {
      try { return resolveEffectiveAgentWorkspaceCwd(source, descriptor.agentId); }
      catch { return fail("path_outside_workspace"); }
    })(),
  };
  const sessionFile = descriptor.sessionFile;
  const message = await findUniquePresentedConversationMessage(sessionFile, messageId.trim(), options?.transcriptRead);
  if (!isUserVisibleAssistantConversationMessage(message)) fail("ineligible_message");
  if (!extractPresentedArtifactPaths(message.text).some(p => samePath(p, target))) fail("path_not_presented");
  const authorizedTarget = await resolveCanonicalPresentedArtifactTarget(workspace, target, options?.targetResolution);
  const result = await securelyReadPresentedArtifact(authorizedTarget, { platform: options?.securityPlatform ?? process.platform });
  return { ...result, path: pathValue };
}

export function chatArtifactStatus(code: ChatArtifactErrorCode): number { if (["invalid_request", "invalid_path"].includes(code)) return 400; if (["invalid_transcript_owner", "path_not_presented", "path_outside_workspace", "ineligible_message", "unsafe_file_identity"].includes(code)) return 403; if (["transcript_not_found", "message_not_found", "file_not_found"].includes(code)) return 404; if (["ambiguous_message_id", "corrupt_transcript", "file_identity_changed"].includes(code)) return 409; if (["transcript_too_large", "file_too_large"].includes(code)) return 413; if (code === "stable_identity_unsupported") return 501; return 500; }

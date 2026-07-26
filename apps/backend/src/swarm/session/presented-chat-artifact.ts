import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as path from "node:path";
import MarkdownIt from "markdown-it";
import {
  CHAT_ARTIFACT_MAX_IMAGE_BYTES,
  CHAT_ARTIFACT_MAX_TEXT_BYTES,
  isUserVisibleAssistantConversationMessage,
  type ChatArtifactReadResponse,
} from "@forge/protocol";
import type { AgentDescriptor } from "../types.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "./conversation-timeline.js";
import { isConversationEntryEvent } from "./conversation-validators.js";
import { backfillConversationMessageEntryId } from "./conversation-entry-id.js";
import { MAX_SESSION_FILE_BYTES_FOR_OPEN } from "./session-file-guard.js";
import { MAX_READ_FILE_CONTENT_BYTES } from "../../ws/ws-file-access.js";
import { resolveReadFileContentType } from "../../ws/http-utils.js";

// Keep document reads aligned with the existing 2 MiB text/file-reader budget. Images retain a
// separate 4 MiB budget and capable clients can move those bytes over a one-use HTTP ticket.
export const MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES = CHAT_ARTIFACT_MAX_IMAGE_BYTES;
export const MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES = CHAT_ARTIFACT_MAX_TEXT_BYTES;
if (MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES !== MAX_READ_FILE_CONTENT_BYTES) {
  throw new Error("Chat artifact and generic file-reader text limits must remain aligned");
}

export type ChatArtifactErrorCode = "invalid_request" | "invalid_path" | "invalid_transcript_owner" | "transcript_not_found" | "transcript_too_large" | "corrupt_transcript" | "transcript_read_failed" | "message_not_found" | "ambiguous_message_id" | "ineligible_message" | "path_not_presented" | "file_not_found" | "unsafe_file_identity" | "file_identity_changed" | "file_too_large" | "stable_identity_unsupported" | "ticket_not_found" | "ticket_expired" | "ticket_binding_mismatch" | "ticket_capacity_exceeded";
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
}

/**
 * Resolve a transcript-presented absolute path to its canonical local target. Artifact authority
 * comes from the presenting assistant message, not from the agent's current workspace location.
 */
export async function resolveCanonicalPresentedArtifactTarget(
  target: string,
  hooks: PresentedArtifactTargetResolutionHooks = {},
): Promise<string> {
  const platform = hooks.platform ?? process.platform;
  const resolveRealpath = hooks.realpath ?? (async (value: string) => realpath(value));
  try { return canonicalizeChatArtifactPathForPlatform(await resolveRealpath(target), platform); }
  catch (error: unknown) {
    if ((error as { code?: string })?.code === "ENOENT") fail("file_not_found");
    if (error instanceof ChatArtifactError) throw error;
    return fail("transcript_read_failed");
  }
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

type PresentedArtifactIdentitySnapshot = Awaited<ReturnType<typeof walkFile>>;

function sameArtifactIdentity(a: PresentedArtifactIdentitySnapshot, b: PresentedArtifactIdentitySnapshot): boolean {
  return a.real === b.real && a.finalId === b.finalId && a.finalSize === b.finalSize &&
    a.ids.length === b.ids.length && a.ids.every((id, index) => id === b.ids[index]);
}

function validatePreviewBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES) fail("invalid_request");
  return value as number;
}

export async function securelyInspectPresentedArtifact(target: string): Promise<{
  contentType: string;
  totalBytes: number;
  identity: PresentedArtifactIdentitySnapshot;
}> {
  const contentType = resolveReadFileContentType(target);
  if (!contentType.startsWith("image/")) fail("invalid_request");
  const identity = await walkFile(target, "initial");
  if (identity.finalSize > BigInt(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES)) fail("file_too_large");
  return { contentType, totalBytes: Number(identity.finalSize), identity };
}

export async function securelyReadPresentedArtifact(target: string, hooks?: {
  afterInitialWalk?: () => Promise<void> | void;
  afterOpen?: () => Promise<void> | void;
  /** Test-only observation seam proving bounded reads never consume the discarded tail. */
  onRead?: (bytesRead: number) => void;
  platform?: NodeJS.Platform;
  previewBytes?: number;
  expectedIdentity?: PresentedArtifactIdentitySnapshot;
  rawImage?: boolean;
}): Promise<ChatArtifactReadResponse | { contentType: string; content: Buffer; totalBytes: number }> {
  const contentType = resolveReadFileContentType(target);
  const isImage = contentType.startsWith("image/");
  const maxBytes = isImage ? MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES : MAX_PRESENTED_CHAT_ARTIFACT_TEXT_BYTES;
  const previewBytes = validatePreviewBytes(hooks?.previewBytes);
  const boundedTextRead = !isImage && previewBytes !== undefined;
  const initial = await walkFile(target, "initial");
  if (hooks?.expectedIdentity && !sameArtifactIdentity(initial, hooks.expectedIdentity)) fail("file_identity_changed");
  if ((!boundedTextRead && initial.finalSize > BigInt(maxBytes)) || initial.finalSize > BigInt(Number.MAX_SAFE_INTEGER)) fail("file_too_large");
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
      if ((!boundedTextRead && checked.size > BigInt(maxBytes)) || checked.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("file_too_large");
      if (checked.size !== initial.finalSize) fail("file_identity_changed");
      return checked;
    };
    await verifyHandle();
    await hooks?.afterOpen?.();
    const opened = await verifyHandle();
    const verifyPath = async () => {
      const post = await walkFile(target, "post");
      if (!sameArtifactIdentity(post, initial) || post.finalId !== stableFileIdentity(opened)) fail("file_identity_changed");
      if ((!boundedTextRead && post.finalSize > BigInt(maxBytes)) || post.finalSize > BigInt(Number.MAX_SAFE_INTEGER)) fail("file_too_large");
    };
    await verifyPath();
    const totalBytes = Number(opened.size);
    const requestedReadBytes = !isImage && previewBytes !== undefined ? Math.min(previewBytes, totalBytes) : totalBytes;
    const buffer = Buffer.alloc(requestedReadBytes); let offset = 0;
    while (offset < buffer.length) {
      let bytesRead = 0;
      try { ({ bytesRead } = await openedHandle.read(buffer, offset, buffer.length - offset, offset)); } catch { fail("transcript_read_failed"); }
      if (!bytesRead) break;
      hooks?.onRead?.(bytesRead);
      offset += bytesRead;
    }
    if (offset !== requestedReadBytes) fail("file_identity_changed");
    await verifyHandle();
    await verifyPath();
    const content = buffer.subarray(0, offset);
    const binary = isImage || content.subarray(0, 4000).some((b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13));
    if (hooks?.rawImage) {
      if (!isImage) fail("invalid_request");
      return { contentType, content, totalBytes };
    }
    if (binary) {
      if (previewBytes !== undefined && !isImage) fail("invalid_request");
      return { path: target, binary: true, encoding: "base64", contentType, content: content.toString("base64") };
    }
    if (previewBytes !== undefined) {
      const truncated = totalBytes > offset;
      const decoder = new StringDecoder("utf8");
      const text = decoder.write(content) + (truncated ? "" : decoder.end());
      return { path: target, content: text, contentType, truncated, totalBytes };
    }
    return { path: target, content: content.toString("utf8"), contentType };
  } finally { await openedHandle.close(); }
}

export const PRESENTED_CHAT_ARTIFACT_TICKET_TTL_MS = 30_000;
const MAX_PRESENTED_CHAT_ARTIFACT_TICKETS = 256;
const MAX_PRESENTED_CHAT_ARTIFACT_TICKETS_PER_AUTH_BINDING = 64;
// Builder is one deliberate local principal and retains the pre-existing full-store allowance.
const MAX_LOCAL_PRESENTED_CHAT_ARTIFACT_TICKETS = MAX_PRESENTED_CHAT_ARTIFACT_TICKETS;
const CHAT_ARTIFACT_TICKET_PATH_PREFIX = "/api/chat-artifacts/tickets/";

type PresentedChatArtifactTicketRecord = {
  target: string;
  identity: PresentedArtifactIdentitySnapshot;
  contentType: string;
  totalBytes: number;
  expiresAtMs: number;
  authBinding?: string;
};

/** In-memory, bounded, one-use capability store. No local path is placed in the capability URL. */
export class PresentedChatArtifactTicketStore {
  private readonly tickets = new Map<string, PresentedChatArtifactTicketRecord>();
  constructor(private readonly options: {
    now?: () => number;
    createToken?: () => string;
    ttlMs?: number;
    /** Test seam that may lower, but never raise, the production hard cap. */
    maxTickets?: number;
    maxTicketsPerAuthBinding?: number;
    maxLocalTickets?: number;
  } = {}) {}

  async issue(target: string, authBinding?: string) {
    const inspected = await securelyInspectPresentedArtifact(target);
    const token = this.options.createToken?.() ?? randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token) || this.tickets.has(token)) fail("transcript_read_failed");
    const now = this.now();
    this.purgeExpired(now);
    this.reserveIssuerOwnedSlot(authBinding);
    const expiresAtMs = now + (this.options.ttlMs ?? PRESENTED_CHAT_ARTIFACT_TICKET_TTL_MS);
    this.tickets.set(token, { target, ...inspected, expiresAtMs, ...(authBinding !== undefined ? { authBinding } : {}) });
    return {
      contentType: inspected.contentType,
      totalBytes: inspected.totalBytes,
      ticket: { url: `${CHAT_ARTIFACT_TICKET_PATH_PREFIX}${token}`, expiresAt: new Date(expiresAtMs).toISOString() },
    };
  }

  async redeem(token: string, authBinding?: string) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) fail("ticket_not_found");
    const ticket = this.tickets.get(token);
    if (!ticket) throw new ChatArtifactError("ticket_not_found");
    // A binding mismatch is indistinguishable from an unknown token and never consumes the owner's ticket.
    if (ticket.authBinding !== authBinding) fail("ticket_not_found");
    if (ticket.expiresAtMs <= this.now()) {
      this.tickets.delete(token);
      fail("ticket_expired");
    }
    // This synchronous delete is the final operation before the first awaited I/O. Concurrent valid
    // redeems therefore still have exactly one winner while validation failures leave the token intact.
    this.tickets.delete(token);
    const readResult = await securelyReadPresentedArtifact(ticket.target, {
      expectedIdentity: ticket.identity,
      rawImage: true,
    });
    if (!("content" in readResult) || !Buffer.isBuffer(readResult.content) || !("totalBytes" in readResult)) fail("transcript_read_failed");
    const result = readResult as { contentType: string; content: Buffer; totalBytes: number };
    if (result.contentType !== ticket.contentType || result.totalBytes !== ticket.totalBytes) fail("file_identity_changed");
    return result;
  }

  private boundedLimit(value: number | undefined, fallback: number, ceiling: number) {
    const requested = value === undefined || Number.isNaN(value) ? fallback : value;
    return Math.min(ceiling, Math.max(1, Math.floor(requested)));
  }

  private reserveIssuerOwnedSlot(authBinding: string | undefined) {
    const overallLimit = this.boundedLimit(this.options.maxTickets, MAX_PRESENTED_CHAT_ARTIFACT_TICKETS, MAX_PRESENTED_CHAT_ARTIFACT_TICKETS);
    const issuerLimit = authBinding === undefined
      ? this.boundedLimit(this.options.maxLocalTickets, MAX_LOCAL_PRESENTED_CHAT_ARTIFACT_TICKETS, overallLimit)
      : this.boundedLimit(this.options.maxTicketsPerAuthBinding, MAX_PRESENTED_CHAT_ARTIFACT_TICKETS_PER_AUTH_BINDING, overallLimit);
    const issuerTokens = [...this.tickets]
      .filter(([, ticket]) => ticket.authBinding === authBinding)
      .map(([token]) => token);

    if (issuerTokens.length >= issuerLimit) this.tickets.delete(issuerTokens.shift()!);
    if (this.tickets.size < overallLimit) return;

    const issuerOwnedToken = issuerTokens[0];
    if (!issuerOwnedToken) fail("ticket_capacity_exceeded");
    this.tickets.delete(issuerOwnedToken);
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private purgeExpired(now = this.now()) {
    for (const [token, ticket] of this.tickets) if (ticket.expiresAtMs <= now) this.tickets.delete(token);
  }
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
  claim: { transcriptAgentId: unknown; messageId: unknown; path: unknown; previewBytes?: unknown; imageTransport?: unknown },
  options?: {
    securityPlatform?: NodeJS.Platform;
    targetResolution?: PresentedArtifactTargetResolutionHooks;
    transcriptRead?: { afterOpen?: () => Promise<void> | void };
    ticketStore?: PresentedChatArtifactTicketStore;
    ticketAuthBinding?: string;
  },
): Promise<ChatArtifactReadResponse> {
  const raw = claim as Record<string, unknown>;
  if (
    Object.keys(raw).some(key => !["transcriptAgentId", "messageId", "path", "previewBytes", "imageTransport"].includes(key)) ||
    typeof raw.transcriptAgentId !== "string" ||
    typeof raw.messageId !== "string" ||
    typeof raw.path !== "string" ||
    (raw.imageTransport !== undefined && raw.imageTransport !== "http_ticket")
  ) fail("invalid_request");
  const previewBytes = validatePreviewBytes(raw.previewBytes);
  const pathValue = raw.path as string; const transcriptAgentId = raw.transcriptAgentId as string; const messageId = raw.messageId as string;
  const target = canonicalizeChatArtifactPath(pathValue); const descriptor = resolveActiveBuilderTranscriptDescriptor(source, transcriptAgentId.trim());
  const sessionFile = descriptor.sessionFile;
  const message = await findUniquePresentedConversationMessage(sessionFile, messageId.trim(), options?.transcriptRead);
  if (!isUserVisibleAssistantConversationMessage(message)) fail("ineligible_message");
  if (!extractPresentedArtifactPaths(message.text).some(p => samePath(p, target))) fail("path_not_presented");
  const authorizedTarget = await resolveCanonicalPresentedArtifactTarget(target, options?.targetResolution);
  if (raw.imageTransport === "http_ticket" && resolveReadFileContentType(authorizedTarget).startsWith("image/")) {
    const ticketStore = options?.ticketStore;
    if (!ticketStore) throw new ChatArtifactError("invalid_request");
    const issued = await ticketStore.issue(authorizedTarget, options?.ticketAuthBinding);
    return { path: pathValue, binary: true, transport: "http_ticket", ...issued };
  }
  const result = await securelyReadPresentedArtifact(authorizedTarget, {
    platform: options?.securityPlatform ?? process.platform,
    ...(previewBytes !== undefined ? { previewBytes } : {}),
  });
  if ("content" in result && Buffer.isBuffer(result.content)) fail("transcript_read_failed");
  return { ...result, path: pathValue } as ChatArtifactReadResponse;
}

export function chatArtifactStatus(code: ChatArtifactErrorCode): number { if (["invalid_request", "invalid_path"].includes(code)) return 400; if (["invalid_transcript_owner", "path_not_presented", "ineligible_message", "unsafe_file_identity", "ticket_binding_mismatch"].includes(code)) return 403; if (["transcript_not_found", "message_not_found", "file_not_found", "ticket_not_found"].includes(code)) return 404; if (["ambiguous_message_id", "corrupt_transcript", "file_identity_changed"].includes(code)) return 409; if (code === "ticket_expired") return 410; if (["transcript_too_large", "file_too_large"].includes(code)) return 413; if (code === "ticket_capacity_exceeded") return 429; if (code === "stable_identity_unsupported") return 501; return 500; }

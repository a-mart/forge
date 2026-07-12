import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { isUserVisibleAssistantConversationMessage } from "@forge/protocol";
import type { AgentDescriptor } from "../types.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "./conversation-timeline.js";
import { MAX_SESSION_FILE_BYTES_FOR_OPEN } from "./session-file-guard.js";
import { MAX_READ_FILE_CONTENT_BYTES } from "../../ws/ws-file-access.js";
import { resolveReadFileContentType } from "../../ws/http-utils.js";

export type ChatArtifactErrorCode = "invalid_request" | "invalid_path" | "invalid_transcript_owner" | "transcript_not_found" | "transcript_too_large" | "corrupt_transcript" | "transcript_read_failed" | "message_not_found" | "ambiguous_message_id" | "ineligible_message" | "path_not_presented" | "file_not_found" | "unsafe_file_identity" | "file_identity_changed" | "file_too_large" | "stable_identity_unsupported";
export class ChatArtifactError extends Error { constructor(public readonly code: ChatArtifactErrorCode) { super(code); } }
const fail = (code: ChatArtifactErrorCode): never => { throw new ChatArtifactError(code); };
const hasControl = (value: string) => /[\0-\x1f\x7f]/.test(value);

/** Canonical native absolute path. Body values are application data: never decode them here. */
export function canonicalizeChatArtifactPathForPlatform(value: string, platform: NodeJS.Platform = process.platform): string {
  const input = value.trim();
  if (!input || hasControl(input) || /\$\{|\{\{/.test(input) || input === "…") fail("invalid_path");
  if (platform === "win32") {
    if (/^(?:\\\\|\/\/|\\\\[?.]|\\\\\.)/.test(input) || /^[A-Za-z]:[^\\/]/.test(input) || /:[^\\/]/.test(input.slice(2))) fail("invalid_path");
    if (!/^[A-Za-z]:[\\/]/.test(input)) fail("invalid_path");
    const normalized = path.win32.normalize(input).replace(/\\/g, "/");
    if (!/^[A-Za-z]:\//.test(normalized)) fail("invalid_path");
    return normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) fail("invalid_path");
  return path.posix.normalize(input);
}
export function canonicalizeChatArtifactPath(value: string): string { return canonicalizeChatArtifactPathForPlatform(value); }

/** Convert an href emitted by mobile markdown-it to a path, with exactly one URI decode. */
export function canonicalizePresentedLinkHrefForPlatform(href: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let raw: string;
  if (href.startsWith("swarm-file://")) {
    raw = href.slice("swarm-file://".length);
    const suffix = raw.search(/[?#]/); if (suffix >= 0) raw = raw.slice(0, suffix);
    if (platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  } else {
    // Markdown-it rejects file: links. Everything URL-like is excluded here.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//")) return undefined;
    raw = href;
  }
  try { raw = decodeURIComponent(raw); } catch { return undefined; }
  if (hasControl(raw)) return undefined;
  try { return canonicalizeChatArtifactPathForPlatform(raw, platform); } catch { return undefined; }
}
export function canonicalizePresentedLinkHref(href: string): string | undefined { return canonicalizePresentedLinkHrefForPlatform(href); }

/** Small link-token scanner intentionally excludes images, code and raw URLs. */
export function extractPresentedArtifactPaths(markdown: string): string[] {
  const stripped = markdown.replace(/```[\s\S]*?```|`[^`]*`/g, "");
  const values: string[] = [];
  const re = /(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|((?:\\.|[^\s)])+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|<((?:swarm-file:\/\/)[^>]+)>/g;
  for (const match of stripped.matchAll(re)) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (!candidate) continue;
    const canonical = canonicalizePresentedLinkHref(candidate.replace(/\\([()\\])/g, "$1"));
    if (canonical) values.push(canonical);
  }
  return values;
}

function samePath(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
export function stableFileIdentity(stat: { dev: number | bigint; ino: number | bigint; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }) {
  if ((typeof stat.dev !== "number" && typeof stat.dev !== "bigint") || (typeof stat.ino !== "number" && typeof stat.ino !== "bigint") || stat.dev === 0 || stat.ino === 0) fail("stable_identity_unsupported");
  return `${String(stat.dev)}:${String(stat.ino)}:${stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o"}`;
}
async function walkFile(target: string): Promise<{ parts: string[]; ids: string[]; finalId: string; real: string }> {
  const parsed = path.parse(target); const relative = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root; const ids: string[] = [];
  for (let i = 0; i < relative.length; i++) {
    current = path.join(current, relative[i]!);
    let s; try { s = await lstat(current); } catch (e: any) { if (e?.code === "ENOENT") fail("file_not_found"); throw e; }
    if (s.isSymbolicLink()) fail("unsafe_file_identity");
    const id = stableFileIdentity(s);
    if (i < relative.length - 1 && !s.isDirectory()) fail("file_identity_changed");
    if (i === relative.length - 1 && !s.isFile()) fail("invalid_path");
    ids.push(id);
  }
  const resolved = canonicalizeChatArtifactPath(await realpath(target));
  if (!samePath(resolved, target)) fail("unsafe_file_identity");
  return { parts: relative, ids, finalId: ids.at(-1)!, real: resolved };
}

export async function securelyReadPresentedArtifact(target: string, hooks?: { afterInitialWalk?: () => Promise<void> | void; afterOpen?: () => Promise<void> | void }) {
  const initial = await walkFile(target);
  await hooks?.afterInitialWalk?.();
  if (process.platform === "win32") fail("stable_identity_unsupported"); // Node cannot promise no-follow open on Windows.
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (e: any) { if (e?.code === "ENOENT") fail("file_not_found"); if (e?.code === "ELOOP") fail("unsafe_file_identity"); throw e; }
  try {
    const opened = await handle.stat();
    await hooks?.afterOpen?.();
    if (!opened.isFile()) fail("file_identity_changed");
    if (stableFileIdentity(opened) !== initial.finalId) fail("file_identity_changed");
    if (opened.size > MAX_READ_FILE_CONTENT_BYTES) fail("file_too_large");
    const post = await walkFile(target);
    if (post.real !== initial.real || post.ids.length !== initial.ids.length || post.ids.some((id, i) => id !== initial.ids[i]) || post.finalId !== stableFileIdentity(opened)) fail("file_identity_changed");
    const buffer = Buffer.alloc(MAX_READ_FILE_CONTENT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_READ_FILE_CONTENT_BYTES) fail("file_too_large");
    const content = buffer.subarray(0, bytesRead); const contentType = resolveReadFileContentType(target);
    const binary = contentType.startsWith("image/") || content.subarray(0, 4000).some((b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13));
    return binary ? { path: target, binary: true, encoding: "base64", contentType, content: content.toString("base64") } : { path: target, content: content.toString("utf8"), contentType };
  } finally { await handle.close(); }
}

export interface PresentedArtifactOwnerSource { getAgent(id: string): AgentDescriptor | undefined; listProfiles(): Array<{ profileId: string; archivedAt?: string }>; getConfig(): { paths: { dataDir: string } }; }
export function resolveActiveBuilderTranscriptDescriptor(source: PresentedArtifactOwnerSource, id: string): AgentDescriptor {
  const descriptor = source.getAgent(id); const dataDir = source.getConfig().paths.dataDir;
  const profiles = new Map(source.listProfiles().map(p => [p.profileId, p]));
  const isManager = (d: AgentDescriptor | undefined): boolean => Boolean(d && d.role === "manager" && d.managerId === d.agentId && !d.archivedAt && d.sessionSurface !== "collab" && !d.collab && !d.externalThread && d.profileId && !profiles.get(d.profileId)?.archivedAt && samePath(path.normalize(d.sessionFile), path.normalize(getSessionFilePath(dataDir, d.profileId!, d.agentId))));
  if (isManager(descriptor)) return descriptor!;
  if (!descriptor) throw new ChatArtifactError("invalid_transcript_owner");
  const worker: AgentDescriptor = descriptor;
  if (worker.role !== "worker" || worker.archivedAt || worker.collab || worker.sessionSurface === "collab" || worker.externalThread || worker.internalWorkerKind) fail("invalid_transcript_owner");
  const owner = source.getAgent(worker.managerId); if (!isManager(owner) || !owner || (worker.profileId && worker.profileId !== owner.profileId) || !samePath(path.normalize(worker.sessionFile), path.normalize(getWorkerSessionFilePath(dataDir, owner.profileId!, owner.agentId, worker.agentId)))) fail("invalid_transcript_owner");
  return worker;
}

export async function findUniquePresentedConversationMessage(sessionFile: string, messageId: string): Promise<any> {
  if (!messageId.trim()) fail("invalid_request"); let handle;
  try { handle = await open(sessionFile, fsConstants.O_RDONLY); } catch (e: any) { if (e?.code === "ENOENT") fail("transcript_not_found"); fail("transcript_read_failed"); }
  try {
    const openedHandle = handle!;
    const s = await openedHandle.stat(); if (s.size > MAX_SESSION_FILE_BYTES_FOR_OPEN) fail("transcript_too_large");
    let carry = "", total = 0; const found: any[] = []; const buf = Buffer.alloc(64 * 1024);
    for (;;) { const { bytesRead } = await openedHandle.read(buf, 0, buf.length, null); if (!bytesRead) break; total += bytesRead; if (total > MAX_SESSION_FILE_BYTES_FOR_OPEN) fail("transcript_too_large"); carry += buf.toString("utf8", 0, bytesRead); const lines = carry.split("\n"); carry = lines.pop()!;
      for (const line of lines) { if (!line.trim()) continue; let wrapper: any; try { wrapper = JSON.parse(line); } catch { fail("corrupt_transcript"); } if (wrapper?.type === "custom" && wrapper.customType === CONVERSATION_ENTRY_TYPE && wrapper.data?.type === "conversation_message") { const data = wrapper.data.id?.trim() ? wrapper.data : (typeof wrapper.id === "string" && wrapper.id.trim() ? { ...wrapper.data, id: wrapper.id } : wrapper.data); if (data.id === messageId) found.push(data); } }
    }
    if (carry.trim()) { let wrapper: any; try { wrapper = JSON.parse(carry); } catch { fail("corrupt_transcript"); } if (wrapper?.type === "custom" && wrapper.customType === CONVERSATION_ENTRY_TYPE && wrapper.data?.type === "conversation_message") { const data = wrapper.data.id?.trim() ? wrapper.data : (typeof wrapper.id === "string" && wrapper.id.trim() ? { ...wrapper.data, id: wrapper.id } : wrapper.data); if (data.id === messageId) found.push(data); } }
    if (!found.length) fail("message_not_found"); if (found.length !== 1) fail("ambiguous_message_id"); return found[0];
  } finally { await handle!.close(); }
}

export async function readPresentedChatArtifact(source: PresentedArtifactOwnerSource, claim: { transcriptAgentId: unknown; messageId: unknown; path: unknown }) {
  const raw = claim as { transcriptAgentId?: unknown; messageId?: unknown; path?: unknown };
  if (typeof raw.transcriptAgentId !== "string" || typeof raw.messageId !== "string" || typeof raw.path !== "string") fail("invalid_request");
  const transcriptAgentId = raw.transcriptAgentId as string;
  const messageId = raw.messageId as string;
  const target = canonicalizeChatArtifactPath(raw.path as string); const descriptor = resolveActiveBuilderTranscriptDescriptor(source, transcriptAgentId.trim());
  const message = await findUniquePresentedConversationMessage(descriptor.sessionFile, messageId.trim());
  if (!isUserVisibleAssistantConversationMessage(message)) fail("ineligible_message");
  if (!extractPresentedArtifactPaths(message.text ?? "").some(p => samePath(p, target))) fail("path_not_presented");
  return securelyReadPresentedArtifact(target);
}

export function chatArtifactStatus(code: ChatArtifactErrorCode): number { if (["invalid_request", "invalid_path", "ineligible_message"].includes(code)) return code === "ineligible_message" ? 403 : 400; if (["invalid_transcript_owner", "path_not_presented", "unsafe_file_identity"].includes(code)) return 403; if (["transcript_not_found", "message_not_found", "file_not_found"].includes(code)) return 404; if (["ambiguous_message_id", "corrupt_transcript", "file_identity_changed"].includes(code)) return 409; if (["transcript_too_large", "file_too_large"].includes(code)) return 413; if (code === "stable_identity_unsupported") return 501; return 500; }

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ConversationMessageAttachment } from "./types.js";

export interface PinEntry {
  pinnedAt: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface PinRegistry {
  version: 1;
  pins: Record<string, PinEntry>;
}

export const MAX_PINS_PER_SESSION = 10;
export const PINNED_MESSAGES_FILE_NAME = "pinned-messages.json";
export const PINNED_MESSAGES_COMPACTION_SECTION_TITLE = "## Preserved Messages (Pinned)";

const EMPTY_PIN_REGISTRY: PinRegistry = {
  version: 1,
  pins: {}
};

const pinLocks = new Map<string, Promise<void>>();

export async function loadPins(sessionDir: string): Promise<PinRegistry> {
  const filePath = getPinsFilePath(sessionDir);

  try {
    const raw = await readFile(filePath, "utf8");
    return normalizeRegistry(JSON.parse(raw));
  } catch {
    return cloneRegistry(EMPTY_PIN_REGISTRY);
  }
}

export async function savePins(sessionDir: string, registry: PinRegistry): Promise<void> {
  const normalizedRegistry = normalizeRegistry(registry);
  const normalizedSessionDir = resolve(sessionDir);
  const filePath = getPinsFilePath(normalizedSessionDir);
  const tempPath = join(
    normalizedSessionDir,
    `${PINNED_MESSAGES_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`
  );

  await mkdir(normalizedSessionDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(normalizedRegistry, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function togglePin(
  sessionDir: string,
  messageId: string,
  pinned: boolean,
  messageContent?: {
    role: "user" | "assistant";
    text: string;
    timestamp: string;
    attachments?: ConversationMessageAttachment[];
  }
): Promise<PinRegistry> {
  const normalizedSessionDir = resolve(sessionDir);
  return withPinLock(normalizedSessionDir, () =>
    togglePinInternal(normalizedSessionDir, messageId, pinned, messageContent)
  );
}

export async function clearAllPins(sessionDir: string): Promise<string[]> {
  const normalizedSessionDir = resolve(sessionDir);
  return withPinLock(normalizedSessionDir, async () => {
    const registry = await loadPins(normalizedSessionDir);
    const pinnedMessageIds = Object.keys(registry.pins);

    if (pinnedMessageIds.length === 0) {
      return [];
    }

    await savePins(normalizedSessionDir, EMPTY_PIN_REGISTRY);
    return pinnedMessageIds;
  });
}

async function withPinLock<T>(sessionDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = pinLocks.get(sessionDir) ?? Promise.resolve();
  let releaseCurrentLock: (() => void) | undefined;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrentLock = resolveCurrent;
  });
  const nextLock = previous.catch(() => {}).then(() => current);
  pinLocks.set(sessionDir, nextLock);

  await previous.catch(() => {});

  try {
    return await operation();
  } finally {
    releaseCurrentLock?.();
    if (pinLocks.get(sessionDir) === nextLock) {
      pinLocks.delete(sessionDir);
    }
  }
}

async function togglePinInternal(
  sessionDir: string,
  messageId: string,
  pinned: boolean,
  messageContent?: {
    role: "user" | "assistant";
    text: string;
    timestamp: string;
    attachments?: ConversationMessageAttachment[];
  }
): Promise<PinRegistry> {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) {
    throw new Error("Message id must be non-empty");
  }

  const registry = await loadPins(sessionDir);

  if (!pinned) {
    if (!(normalizedMessageId in registry.pins)) {
      return registry;
    }

    delete registry.pins[normalizedMessageId];
    await savePins(sessionDir, registry);
    return registry;
  }

  if (!messageContent) {
    throw new Error("Pinned messages require conversation content");
  }

  const existingEntry = registry.pins[normalizedMessageId];
  if (!existingEntry && Object.keys(registry.pins).length >= MAX_PINS_PER_SESSION) {
    throw new Error(`A session can have at most ${MAX_PINS_PER_SESSION} pinned messages`);
  }

  registry.pins[normalizedMessageId] = {
    pinnedAt: existingEntry?.pinnedAt ?? new Date().toISOString(),
    role: messageContent.role,
    text: serializePinnedMessageText(messageContent),
    timestamp: messageContent.timestamp
  };

  await savePins(sessionDir, registry);
  return registry;
}

export function formatPinnedMessagesForCompaction(registry: PinRegistry): string | undefined {
  const normalizedRegistry = normalizeRegistry(registry);
  const entries = Object.entries(normalizedRegistry.pins)
    .sort((left, right) => {
      const leftPinnedAt = left[1].pinnedAt;
      const rightPinnedAt = right[1].pinnedAt;
      return leftPinnedAt.localeCompare(rightPinnedAt);
    })
    .map(([, entry]) => entry);

  if (entries.length === 0) {
    return undefined;
  }

  const sections = entries.map((entry, index) => {
    const roleLabel = entry.role === "user" ? "User" : "Assistant";
    return [
      `### Pinned Message ${index + 1} (${roleLabel}, ${formatTimestampForDisplay(entry.timestamp)}):`,
      entry.text
    ].join("\n");
  });

  return [
    "The user has pinned the following messages to be preserved through compaction. You MUST include these messages VERBATIM in your summary, in a clearly marked section titled \"## Preserved Messages (Pinned)\". Do not paraphrase, summarize, or omit any of these messages:",
    "",
    sections.join("\n\n")
  ].join("\n");
}

export function combineCompactionCustomInstructions(
  existingInstructions: string | undefined,
  registry: PinRegistry
): string | undefined {
  const pinnedInstructions = formatPinnedMessagesForCompaction(registry);
  const normalizedExisting = normalizeOptionalString(existingInstructions);

  if (!pinnedInstructions) {
    return normalizedExisting;
  }

  if (!normalizedExisting) {
    return pinnedInstructions;
  }

  if (normalizedExisting.includes(PINNED_MESSAGES_COMPACTION_SECTION_TITLE)) {
    return normalizedExisting;
  }

  return `${normalizedExisting}\n\n${pinnedInstructions}`;
}

function getPinsFilePath(sessionDir: string): string {
  return join(resolve(sessionDir), PINNED_MESSAGES_FILE_NAME);
}

function serializePinnedMessageText(messageContent: {
  text: string;
  attachments?: ConversationMessageAttachment[];
}): string {
  const attachmentSummary = formatAttachmentSummary(messageContent.attachments);
  const hasText = hasMeaningfulPinnedText(messageContent.text);

  if (!attachmentSummary) {
    return hasText ? messageContent.text : messageContent.text.trim();
  }

  if (!hasText) {
    return attachmentSummary;
  }

  return messageContent.text.endsWith("\n")
    ? `${messageContent.text}${attachmentSummary}`
    : `${messageContent.text}\n${attachmentSummary}`;
}

function hasMeaningfulPinnedText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== ".";
}

function formatAttachmentSummary(attachments: ConversationMessageAttachment[] | undefined): string | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const descriptions = attachments.map((attachment, index) => formatAttachmentDescription(attachment, index + 1));
  return `[Attached: ${descriptions.join(", ")}]`;
}

function formatAttachmentDescription(attachment: ConversationMessageAttachment, index: number): string {
  const fileLabel = resolveAttachmentLabel(attachment, index);
  const mimeType = typeof attachment.mimeType === "string" && attachment.mimeType.trim().length > 0
    ? attachment.mimeType.trim()
    : "unknown mime";
  return `${fileLabel} (${mimeType})`;
}

function resolveAttachmentLabel(attachment: ConversationMessageAttachment, index: number): string {
  const normalizedFileName = normalizeOptionalString(attachment.fileName);
  if (normalizedFileName) {
    return normalizedFileName;
  }

  const normalizedFilePath = normalizeOptionalString(attachment.filePath);
  if (normalizedFilePath) {
    return basename(normalizedFilePath);
  }

  const normalizedFileRef = "fileRef" in attachment ? normalizeOptionalString(attachment.fileRef) : undefined;
  if (normalizedFileRef) {
    return normalizedFileRef;
  }

  return `attachment ${index}`;
}

function normalizeRegistry(value: unknown): PinRegistry {
  if (!value || typeof value !== "object") {
    return cloneRegistry(EMPTY_PIN_REGISTRY);
  }

  const maybeRegistry = value as Partial<PinRegistry> & { pins?: unknown };
  if (maybeRegistry.version !== 1 || !maybeRegistry.pins || typeof maybeRegistry.pins !== "object") {
    return cloneRegistry(EMPTY_PIN_REGISTRY);
  }

  const pins: Record<string, PinEntry> = {};

  for (const [messageId, entry] of Object.entries(maybeRegistry.pins)) {
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      continue;
    }

    const normalizedEntry = normalizePinEntry(entry);
    if (!normalizedEntry) {
      continue;
    }

    pins[messageId] = normalizedEntry;
  }

  return {
    version: 1,
    pins
  };
}

function normalizePinEntry(value: unknown): PinEntry | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeEntry = value as Partial<PinEntry>;
  if (typeof maybeEntry.pinnedAt !== "string" || maybeEntry.pinnedAt.trim().length === 0) {
    return undefined;
  }
  if (maybeEntry.role !== "user" && maybeEntry.role !== "assistant") {
    return undefined;
  }
  if (typeof maybeEntry.text !== "string") {
    return undefined;
  }
  if (typeof maybeEntry.timestamp !== "string" || maybeEntry.timestamp.trim().length === 0) {
    return undefined;
  }

  return {
    pinnedAt: maybeEntry.pinnedAt,
    role: maybeEntry.role,
    text: maybeEntry.text,
    timestamp: maybeEntry.timestamp
  };
}

function formatTimestampForDisplay(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }

  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cloneRegistry(registry: PinRegistry): PinRegistry {
  return {
    version: 1,
    pins: Object.fromEntries(
      Object.entries(registry.pins).map(([messageId, entry]) => [messageId, { ...entry }])
    )
  };
}

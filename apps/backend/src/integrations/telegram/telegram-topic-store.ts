import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeManagerId } from "../../utils/normalize.js";

const INTEGRATIONS_DIR_NAME = "integrations";
const INTEGRATIONS_MANAGERS_DIR_NAME = "managers";
const TELEGRAM_TOPICS_FILE_NAME = "telegram-topics.json";

export interface TelegramTopicMapping {
  sessionAgentId: string;
  chatId: string;
  messageThreadId: number;
  topicName: string;
  createdAt: string;
}

export interface TelegramTopicStore {
  mappings: TelegramTopicMapping[];
}

export function getTopicStorePath(dataDir: string, managerId: string): string {
  const normalizedManagerId = normalizeManagerId(managerId);
  return resolve(
    dataDir,
    INTEGRATIONS_DIR_NAME,
    INTEGRATIONS_MANAGERS_DIR_NAME,
    normalizedManagerId,
    TELEGRAM_TOPICS_FILE_NAME
  );
}

export async function loadTopicStore(dataDir: string, managerId: string): Promise<TelegramTopicStore> {
  const storePath = getTopicStorePath(dataDir, managerId);

  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return { mappings: [] };
    }

    throw error;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { mappings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { mappings: [] };
  }

  return parseTopicStore(parsed);
}

export async function saveTopicStore(
  dataDir: string,
  managerId: string,
  store: TelegramTopicStore
): Promise<void> {
  const storePath = getTopicStorePath(dataDir, managerId);
  const tmpPath = `${storePath}.tmp`;

  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmpPath, storePath);
}

export function findTopicForSession(
  store: TelegramTopicStore,
  sessionAgentId: string,
  chatId: string
): TelegramTopicMapping | undefined {
  return store.mappings.find(
    (mapping) => mapping.sessionAgentId === sessionAgentId && mapping.chatId === chatId
  );
}

export function findSessionForTopic(
  store: TelegramTopicStore,
  chatId: string,
  messageThreadId: number
): TelegramTopicMapping | undefined {
  return store.mappings.find(
    (mapping) => mapping.chatId === chatId && mapping.messageThreadId === messageThreadId
  );
}

export function addTopicMapping(store: TelegramTopicStore, mapping: TelegramTopicMapping): void {
  store.mappings = store.mappings.filter(
    (entry) => !(entry.sessionAgentId === mapping.sessionAgentId && entry.chatId === mapping.chatId)
  );
  store.mappings.push({ ...mapping });
}

export function removeTopicMapping(
  store: TelegramTopicStore,
  sessionAgentId: string
): TelegramTopicMapping | undefined {
  const index = store.mappings.findIndex((mapping) => mapping.sessionAgentId === sessionAgentId);
  if (index < 0) {
    return undefined;
  }

  const [removed] = store.mappings.splice(index, 1);
  return removed;
}

function parseTopicStore(value: unknown): TelegramTopicStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mappings: [] };
  }

  const root = value as { mappings?: unknown };
  if (!Array.isArray(root.mappings)) {
    return { mappings: [] };
  }

  const mappings: TelegramTopicMapping[] = [];

  for (const candidate of root.mappings) {
    const mapping = parseTopicMapping(candidate);
    if (mapping) {
      mappings.push(mapping);
    }
  }

  return { mappings };
}

function parseTopicMapping(value: unknown): TelegramTopicMapping | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as {
    sessionAgentId?: unknown;
    chatId?: unknown;
    messageThreadId?: unknown;
    topicName?: unknown;
    createdAt?: unknown;
  };

  const sessionAgentId = normalizeOptionalString(candidate.sessionAgentId);
  const chatId = normalizeOptionalString(candidate.chatId);
  const topicName = normalizeOptionalString(candidate.topicName) ?? "Session";
  const createdAt = normalizeOptionalString(candidate.createdAt) ?? new Date().toISOString();

  if (!sessionAgentId || !chatId) {
    return undefined;
  }

  if (typeof candidate.messageThreadId !== "number" || !Number.isFinite(candidate.messageThreadId)) {
    return undefined;
  }

  return {
    sessionAgentId,
    chatId,
    messageThreadId: Math.trunc(candidate.messageThreadId),
    topicName,
    createdAt
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

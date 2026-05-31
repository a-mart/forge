import type { CodexSidecarActiveTurn } from "./types.js";
import { parseTurnIdFromNotificationParams } from "./codex-sidecar-ids.js";

export const CODEX_DETAIL_TOOL_COMMAND = "codex_command";
export const CODEX_DETAIL_TOOL_MCP = "codex_mcp_tool";
export const CODEX_DETAIL_TOOL_FILE = "codex_file_change";
export const CODEX_DETAIL_TOOL_PLAN = "codex_plan";

export const CODEX_DETAIL_MAX_ROWS_PER_TURN = 80;
export const CODEX_DETAIL_MAX_UPDATES_PER_ITEM = 5;
export const CODEX_DETAIL_MIN_UPDATE_INTERVAL_MS = 500;
export const CODEX_DETAIL_MAX_TEXT_BYTES = 16 * 1024;
export const CODEX_DETAIL_MAX_BYTES_PER_TURN = 256 * 1024;
export const CODEX_DETAIL_MAX_LABEL_CHARS = 240;

const SECRET_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|apikey|api_key|token|access_token|refresh_token|secret|password)$/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+\b/gi;
const SK_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const ALLOWED_DETAIL_ITEM_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "fileChange",
  "plan",
  "dynamicToolCall",
]);

const DENIED_DETAIL_ITEM_TYPES = new Set([
  "reasoning",
  "agentMessage",
  "userMessage",
  "hookPrompt",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

export type CodexDetailDisplayKind = "command" | "mcp" | "file" | "plan" | "unknown";

export interface CodexTrackedDetailItem {
  itemId: string;
  turnId: string;
  itemType: string;
  displayKind: CodexDetailDisplayKind;
  toolName: string;
  toolCallId: string;
  startedAt: string;
  latestStatus?: "running" | "completed" | "failed" | "cancelled";
  emittedStart?: boolean;
  emittedUpdateCount?: number;
  emittedEnd?: boolean;
  lastUpdateEmittedAtMs?: number;
}

export interface CodexDetailCounters {
  emittedRowsThisTurn: number;
  droppedRowsThisTurn: number;
  emittedBytesThisTurn: number;
  capNoticeEmitted?: boolean;
}

export interface CodexNormalizedDetailRow {
  kind: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolCallId: string;
  toolName: string;
  text: string;
  isError?: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
}

export interface CodexDetailNotificationContext {
  method: string;
  params: unknown;
  activeTurn: CodexSidecarActiveTurn;
  nowIso: string;
  nowMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function extractStableItemId(params: unknown, item?: unknown): string | undefined {
  if (item && isRecord(item) && typeof item.id === "string" && item.id.trim()) {
    return item.id.trim();
  }

  if (!isRecord(params)) {
    return undefined;
  }

  const itemId = params.itemId;
  if (typeof itemId === "string" && itemId.trim()) {
    return itemId.trim();
  }

  const nestedItem = params.item;
  if (isRecord(nestedItem) && typeof nestedItem.id === "string" && nestedItem.id.trim()) {
    return nestedItem.id.trim();
  }

  return undefined;
}

export function parseThreadItemType(item: unknown): string | undefined {
  if (!isRecord(item) || typeof item.type !== "string") {
    return undefined;
  }

  return item.type;
}

export function isDeniedCodexDetailItemType(itemType: string | undefined): boolean {
  if (!itemType) {
    return true;
  }

  return DENIED_DETAIL_ITEM_TYPES.has(itemType);
}

export function isAllowedCodexDetailItemType(itemType: string | undefined): boolean {
  if (!itemType) {
    return false;
  }

  return ALLOWED_DETAIL_ITEM_TYPES.has(itemType);
}

export function resolveCodexDetailToolName(itemType: string): string {
  switch (itemType) {
    case "commandExecution":
      return CODEX_DETAIL_TOOL_COMMAND;
    case "mcpToolCall":
    case "dynamicToolCall":
      return CODEX_DETAIL_TOOL_MCP;
    case "fileChange":
      return CODEX_DETAIL_TOOL_FILE;
    case "plan":
      return CODEX_DETAIL_TOOL_PLAN;
    default:
      return CODEX_DETAIL_TOOL_MCP;
  }
}

export function isCodexStreamDetailToolName(toolName: string | undefined): boolean {
  return (
    toolName === CODEX_DETAIL_TOOL_COMMAND ||
    toolName === CODEX_DETAIL_TOOL_MCP ||
    toolName === CODEX_DETAIL_TOOL_FILE ||
    toolName === CODEX_DETAIL_TOOL_PLAN
  );
}

export function resolveCodexDetailDisplayKind(itemType: string): CodexDetailDisplayKind {
  switch (itemType) {
    case "commandExecution":
      return "command";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "mcp";
    case "fileChange":
      return "file";
    case "plan":
      return "plan";
    default:
      return "unknown";
  }
}

export function mapCodexItemStatus(
  status: unknown,
): "running" | "completed" | "failed" | "cancelled" | undefined {
  if (status === "inProgress") {
    return "running";
  }

  if (status === "completed") {
    return "completed";
  }

  if (status === "failed" || status === "declined" || status === "errored") {
    return status === "declined" ? "cancelled" : "failed";
  }

  if (status === "interrupted") {
    return "cancelled";
  }

  return undefined;
}

export function shouldAcceptCodexDetailNotification(
  activeTurn: CodexSidecarActiveTurn | undefined,
  notificationTurnId: string | undefined,
  itemId: string | undefined,
): boolean {
  if (!activeTurn || activeTurn.suppressed) {
    return false;
  }

  if (notificationTurnId) {
    if (activeTurn.turnId !== notificationTurnId) {
      return false;
    }

    return true;
  }

  if (!itemId) {
    return false;
  }

  return activeTurn.codexItemsById?.has(itemId) === true;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SK_KEY_PATTERN, "[redacted-api-key]")
    .replace(JWT_PATTERN, "[redacted-token]");
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizePrimitive(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    return truncateText(redactString(value), CODEX_DETAIL_MAX_TEXT_BYTES);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizePrimitive(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return String(value);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizePrimitive(nested, depth + 1);
  }

  return sanitized;
}

export function safeJson(value: unknown): string {
  try {
    const sanitized = sanitizePrimitive(value);
    const serialized = JSON.stringify(sanitized);
    if (Buffer.byteLength(serialized, "utf8") <= CODEX_DETAIL_MAX_TEXT_BYTES) {
      return serialized;
    }

    return truncateText(serialized, CODEX_DETAIL_MAX_TEXT_BYTES);
  } catch {
    return '{"note":"Unable to serialize Codex detail payload."}';
  }
}

function buildCommandPreview(item: Record<string, unknown>): Record<string, unknown> {
  const command =
    typeof item.command === "string"
      ? truncateText(redactString(item.command), CODEX_DETAIL_MAX_LABEL_CHARS)
      : item.command;

  return {
    command,
    cwd: item.cwd,
    status: item.status,
    exitCode: item.exitCode,
    outputPreview: truncateText(
      redactString(typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : ""),
      512,
    ),
  };
}

function buildMcpPreview(item: Record<string, unknown>): Record<string, unknown> {
  return {
    server: item.server,
    tool: item.tool,
    namespace: item.namespace,
    status: item.status,
    arguments: item.arguments,
    error: item.error,
    resultPreview:
      item.result && isRecord(item.result)
        ? { contentLength: Array.isArray(item.result.content) ? item.result.content.length : 0 }
        : undefined,
  };
}

function buildFilePreview(item: Record<string, unknown>): Record<string, unknown> {
  const changes = Array.isArray(item.changes)
    ? item.changes.slice(0, 10).map((change) => {
        if (!isRecord(change)) {
          return change;
        }

        return {
          path: change.path,
          kind: change.kind,
          diffPreview: truncateText(
            redactString(typeof change.diff === "string" ? change.diff : ""),
            256,
          ),
        };
      })
    : [];

  return {
    status: item.status,
    changes,
  };
}

function buildPlanPreview(item: Record<string, unknown>): Record<string, unknown> {
  return {
    text: truncateText(redactString(typeof item.text === "string" ? item.text : ""), 1024),
    status: item.status,
  };
}

export function buildCodexItemDisplayPayload(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  const itemType = parseThreadItemType(item);
  if (!itemType || !isAllowedCodexDetailItemType(itemType)) {
    return undefined;
  }

  switch (itemType) {
    case "commandExecution":
      return buildCommandPreview(item);
    case "mcpToolCall":
    case "dynamicToolCall":
      return buildMcpPreview(item);
    case "fileChange":
      return buildFilePreview(item);
    case "plan":
      return buildPlanPreview(item);
    default:
      return undefined;
  }
}

function buildProgressPayload(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === "item/commandExecution/outputDelta") {
    return {
      delta: truncateText(redactString(typeof params.delta === "string" ? params.delta : ""), 512),
    };
  }

  if (method === "item/mcpToolCall/progress") {
    return {
      message: truncateText(redactString(typeof params.message === "string" ? params.message : ""), 512),
    };
  }

  if (method === "item/plan/delta") {
    return {
      delta: truncateText(redactString(typeof params.delta === "string" ? params.delta : ""), 512),
    };
  }

  if (method === "item/fileChange/patchUpdated") {
    const changes = Array.isArray(params.changes)
      ? params.changes.slice(0, 5).map((change) => {
          if (!isRecord(change)) {
            return change;
          }

          return {
            path: change.path,
            kind: change.kind,
            diffPreview: truncateText(
              redactString(typeof change.diff === "string" ? change.diff : ""),
              256,
            ),
          };
        })
      : [];

    return { changes };
  }

  if (method === "item/fileChange/outputDelta") {
    return {
      delta: truncateText(redactString(typeof params.delta === "string" ? params.delta : ""), 512),
    };
  }

  return { method };
}

function ensureDetailState(activeTurn: CodexSidecarActiveTurn): {
  items: Map<string, CodexTrackedDetailItem>;
  counters: CodexDetailCounters;
} {
  if (!activeTurn.codexItemsById) {
    activeTurn.codexItemsById = new Map();
  }

  if (!activeTurn.codexDetailCounters) {
    activeTurn.codexDetailCounters = {
      emittedRowsThisTurn: 0,
      droppedRowsThisTurn: 0,
      emittedBytesThisTurn: 0,
    };
  }

  return {
    items: activeTurn.codexItemsById,
    counters: activeTurn.codexDetailCounters,
  };
}

function canEmitRow(activeTurn: CodexSidecarActiveTurn, text: string): boolean {
  const { counters } = ensureDetailState(activeTurn);
  if (counters.emittedRowsThisTurn >= CODEX_DETAIL_MAX_ROWS_PER_TURN) {
    counters.droppedRowsThisTurn += 1;
    return false;
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (counters.emittedBytesThisTurn + bytes > CODEX_DETAIL_MAX_BYTES_PER_TURN) {
    counters.droppedRowsThisTurn += 1;
    return false;
  }

  counters.emittedRowsThisTurn += 1;
  counters.emittedBytesThisTurn += bytes;
  return true;
}

function buildCapNoticeRow(activeTurn: CodexSidecarActiveTurn): CodexNormalizedDetailRow | undefined {
  const { counters } = ensureDetailState(activeTurn);
  if (counters.capNoticeEmitted) {
    return undefined;
  }

  counters.capNoticeEmitted = true;
  return {
    kind: "tool_execution_end",
    toolCallId: `codex-cap-${activeTurn.turnId}`,
    toolName: CODEX_DETAIL_TOOL_COMMAND,
    text: safeJson({
      status: "completed",
      note: "Additional Codex detail output omitted after cap.",
      droppedRows: counters.droppedRowsThisTurn,
    }),
    status: "completed",
  };
}

function trackItem(
  activeTurn: CodexSidecarActiveTurn,
  item: Record<string, unknown>,
  turnId: string,
  startedAt: string,
): CodexTrackedDetailItem | undefined {
  const itemType = parseThreadItemType(item);
  if (!itemType || !isAllowedCodexDetailItemType(itemType)) {
    return undefined;
  }

  const itemId = extractStableItemId(undefined, item);
  if (!itemId) {
    return undefined;
  }

  const { items } = ensureDetailState(activeTurn);
  const existing = items.get(itemId);
  if (existing) {
    return existing;
  }

  const tracked: CodexTrackedDetailItem = {
    itemId,
    turnId,
    itemType,
    displayKind: resolveCodexDetailDisplayKind(itemType),
    toolName: resolveCodexDetailToolName(itemType),
    toolCallId: itemId,
    startedAt,
    latestStatus: mapCodexItemStatus(item.status) ?? "running",
    emittedStart: false,
    emittedUpdateCount: 0,
    emittedEnd: false,
  };

  items.set(itemId, tracked);
  return tracked;
}

export function normalizeCodexDetailNotification(
  context: CodexDetailNotificationContext,
): CodexNormalizedDetailRow[] {
  const { method, params, activeTurn, nowIso } = context;
  const notificationTurnId = parseTurnIdFromNotificationParams(params);
  const item = isRecord(params) ? params.item : undefined;
  const itemId = extractStableItemId(params, item);
  const itemType = parseThreadItemType(item);

  if (method === "item/completed" && itemType === "agentMessage") {
    return [];
  }

  if (itemType !== undefined && isDeniedCodexDetailItemType(itemType)) {
    return [];
  }

  if (!shouldAcceptCodexDetailNotification(activeTurn, notificationTurnId, itemId)) {
    return [];
  }

  if (
    itemType === undefined &&
    (method === "item/commandExecution/outputDelta" ||
      method === "item/mcpToolCall/progress" ||
      method === "item/plan/delta" ||
      method === "item/fileChange/patchUpdated" ||
      method === "item/fileChange/outputDelta")
  ) {
    const trackedItemType = itemId ? activeTurn.codexItemsById?.get(itemId)?.itemType : undefined;
    if (trackedItemType && isDeniedCodexDetailItemType(trackedItemType)) {
      return [];
    }
  }

  const rows: CodexNormalizedDetailRow[] = [];

  if (method === "item/started" && isRecord(item) && notificationTurnId) {
    const tracked = trackItem(activeTurn, item, notificationTurnId, nowIso);
    if (!tracked || tracked.emittedStart) {
      return rows;
    }

    const payload = buildCodexItemDisplayPayload(item);
    if (!payload) {
      return rows;
    }

    const text = safeJson(payload);
    if (!canEmitRow(activeTurn, text)) {
      return rows.length > 0 ? rows : maybeCapNotice(activeTurn);
    }

    tracked.emittedStart = true;
    tracked.latestStatus = mapCodexItemStatus(item.status) ?? "running";
    rows.push({
      kind: "tool_execution_start",
      toolCallId: tracked.toolCallId,
      toolName: tracked.toolName,
      text,
      status: tracked.latestStatus ?? "running",
    });
    return rows;
  }

  if (method === "item/completed" && isRecord(item)) {
    const tracked =
      trackItem(activeTurn, item, notificationTurnId ?? activeTurn.turnId, nowIso) ??
      (itemId ? activeTurn.codexItemsById?.get(itemId) : undefined);
    if (!tracked || tracked.emittedEnd) {
      return rows;
    }

    const payload = buildCodexItemDisplayPayload(item);
    if (!payload) {
      return rows;
    }

    const status = mapCodexItemStatus(item.status) ?? "completed";
    tracked.latestStatus = status;
    const text = safeJson({ ...payload, status });
    if (!canEmitRow(activeTurn, text)) {
      return maybeCapNotice(activeTurn);
    }

    tracked.emittedEnd = true;
    rows.push({
      kind: "tool_execution_end",
      toolCallId: tracked.toolCallId,
      toolName: tracked.toolName,
      text,
      isError: status === "failed",
      status,
    });
    return rows;
  }

  if (
    method === "item/commandExecution/outputDelta" ||
    method === "item/mcpToolCall/progress" ||
    method === "item/plan/delta" ||
    method === "item/fileChange/patchUpdated" ||
    method === "item/fileChange/outputDelta"
  ) {
    if (!itemId) {
      return rows;
    }

    const tracked = activeTurn.codexItemsById?.get(itemId);
    if (!tracked) {
      return rows;
    }

    const { counters } = ensureDetailState(activeTurn);
    const updateCount = tracked.emittedUpdateCount ?? 0;
    if (updateCount >= CODEX_DETAIL_MAX_UPDATES_PER_ITEM) {
      counters.droppedRowsThisTurn += 1;
      return maybeCapNotice(activeTurn);
    }

    const lastAt = tracked.lastUpdateEmittedAtMs ?? 0;
    if (context.nowMs - lastAt < CODEX_DETAIL_MIN_UPDATE_INTERVAL_MS) {
      counters.droppedRowsThisTurn += 1;
      return rows;
    }

    const payload = isRecord(params) ? buildProgressPayload(method, params) : { method };
    const text = safeJson(payload);
    if (!canEmitRow(activeTurn, text)) {
      return maybeCapNotice(activeTurn);
    }

    tracked.emittedUpdateCount = updateCount + 1;
    tracked.lastUpdateEmittedAtMs = context.nowMs;
    tracked.latestStatus = "running";
    rows.push({
      kind: "tool_execution_update",
      toolCallId: tracked.toolCallId,
      toolName: tracked.toolName,
      text,
      status: "running",
    });
    return rows;
  }

  return rows;
}

function maybeCapNotice(activeTurn: CodexSidecarActiveTurn): CodexNormalizedDetailRow[] {
  const notice = buildCapNoticeRow(activeTurn);
  return notice ? [notice] : [];
}

export function finalizeCodexDetailItemsForTurnEnd(
  activeTurn: CodexSidecarActiveTurn,
  reason: "completed" | "cancelled" | "failed",
): CodexNormalizedDetailRow[] {
  const rows: CodexNormalizedDetailRow[] = [];
  const items = activeTurn.codexItemsById;
  if (!items) {
    return rows;
  }

  for (const tracked of items.values()) {
    if (tracked.emittedEnd) {
      continue;
    }

    if (!tracked.emittedStart) {
      continue;
    }

    const status = reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
    const text = safeJson({ status, note: `Codex item closed on turn ${reason}.` });
    if (!canEmitRow(activeTurn, text)) {
      const notice = buildCapNoticeRow(activeTurn);
      if (notice) {
        rows.push(notice);
      }
      break;
    }

    tracked.emittedEnd = true;
    tracked.latestStatus = status;
    rows.push({
      kind: "tool_execution_end",
      toolCallId: tracked.toolCallId,
      toolName: tracked.toolName,
      text,
      isError: status === "failed",
      status,
    });
  }

  return rows;
}

export function resetCodexDetailTurnState(activeTurn: CodexSidecarActiveTurn | undefined): void {
  if (!activeTurn) {
    return;
  }

  activeTurn.codexItemsById = undefined;
  activeTurn.codexDetailCounters = undefined;
}

export function isCodexStreamDetailNotificationMethod(method: string): boolean {
  return (
    method === "item/started" ||
    method === "item/completed" ||
    method === "item/commandExecution/outputDelta" ||
    method === "item/mcpToolCall/progress" ||
    method === "item/plan/delta" ||
    method === "item/fileChange/patchUpdated" ||
    method === "item/fileChange/outputDelta"
  );
}

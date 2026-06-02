import { safeJson } from "./codex-app-server-event-normalizer.js";
import {
  boundCodexMcpToolArgs,
  formatCodexMcpToolFailureMessage,
  truncateBytesUtf8,
} from "./codex-mcp-args.js";
import { assertCodexMcpToolReadOnlyAllowed } from "./codex-mcp-tool-safety.js";
import { parseCodexMcpToolSafetyFields } from "./codex-mcp-tool-safety.js";
import type { CodexAppServerClientPort } from "./types.js";

const CATALOG_CACHE_TTL_MS = 30_000;
const MAX_CATALOG_ENTRIES = 500;
const MAX_TOOL_ARGS_BYTES = 16 * 1024;
const MAX_TOOL_RESULT_BYTES = 32 * 1024;

export interface CodexCatalogApp {
  id: string;
  name: string;
  description?: string;
}

export interface CodexCatalogMcpTool {
  selector: string;
  serverName: string;
  toolName: string;
  appId?: string;
  appName?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  annotations?: Record<string, unknown>;
}

export interface CodexCatalogSnapshot {
  apps: CodexCatalogApp[];
  tools: CodexCatalogMcpTool[];
  fetchedAt: string;
}

export interface CodexMcpToolCallInput {
  managerAgentId: string;
  cwd: string;
  threadId: string;
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export interface CodexMcpToolCallResult {
  auditId: string;
  selector: string;
  serverName: string;
  toolName: string;
  ok: boolean;
  /** Redacted, byte-bounded error preview safe for model context and tool details. */
  errorPreview?: string;
  redactedPreview: string;
}

interface CatalogCacheEntry {
  expiresAt: number;
  snapshot: CodexCatalogSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase();
}

function buildToolSelector(serverName: string, toolName: string): string {
  return `${serverName}/${toolName}`;
}

export class CodexMcpCatalog {
  private cache: CatalogCacheEntry | undefined;

  constructor(private readonly getClient: () => Promise<CodexAppServerClientPort>) {}

  async listCatalog(forceRefresh = false): Promise<CodexCatalogSnapshot> {
    if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.snapshot;
    }

    const client = await this.getClient();
    const apps = await this.fetchApps(client);
    const tools = await this.fetchMcpTools(client, apps);
    const snapshot: CodexCatalogSnapshot = {
      apps,
      tools: tools.slice(0, MAX_CATALOG_ENTRIES),
      fetchedAt: new Date().toISOString(),
    };

    this.cache = {
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
      snapshot,
    };

    return snapshot;
  }

  resolveTool(selector: string, snapshot?: CodexCatalogSnapshot): CodexCatalogMcpTool | undefined {
    const normalized = normalizeSelector(selector);
    const catalog = snapshot ?? this.cache?.snapshot;
    if (!catalog) {
      return undefined;
    }

    const exact = catalog.tools.find((tool) => normalizeSelector(tool.selector) === normalized);
    if (exact) {
      return exact;
    }

    const shortName = catalog.tools.find(
      (tool) =>
        normalizeSelector(tool.toolName) === normalized ||
        normalizeSelector(tool.serverName) === normalized,
    );
    if (shortName && catalog.tools.filter((tool) => normalizeSelector(tool.toolName) === normalized).length === 1) {
      return shortName;
    }

    const suffixMatches = catalog.tools.filter((tool) => {
      const server = normalizeSelector(tool.serverName);
      const name = normalizeSelector(tool.toolName);
      return normalized === name || normalized === server || normalized.endsWith(`/${name}`);
    });

    return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
  }

  validateToolArgs(
    args: Record<string, unknown> | undefined,
    schema: Record<string, unknown> | undefined,
  ): void {
    if (!schema || !isRecord(schema)) {
      return;
    }

    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];

    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    const payload = args ?? {};

    for (const key of required) {
      if (!(key in payload)) {
        throw new Error(`Missing required Codex tool argument: ${key}`);
      }
    }

    if (!properties) {
      return;
    }

    for (const [key, value] of Object.entries(payload)) {
      const propertySchema = properties[key];
      if (!propertySchema || !isRecord(propertySchema)) {
        continue;
      }

      const expectedType = asString(propertySchema.type);
      if (!expectedType) {
        continue;
      }

      if (!valueMatchesSchemaType(value, expectedType)) {
        throw new Error(`Codex tool argument "${key}" must be of type ${expectedType}`);
      }
    }
  }

  boundArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
    return boundCodexMcpToolArgs(args, MAX_TOOL_ARGS_BYTES);
  }

  async callTool(input: CodexMcpToolCallInput, tool: CodexCatalogMcpTool): Promise<CodexMcpToolCallResult> {
    const auditId = `codex-mcp-${Date.now()}`;
    assertCodexMcpToolReadOnlyAllowed(tool);
    const boundedArgs = this.boundArgs(input.args);
    this.validateToolArgs(boundedArgs, tool.inputSchema);

    const client = await this.getClient();

    try {
      const response = await client.request<unknown>("mcpServer/tool/call", {
        threadId: input.threadId,
        cwd: input.cwd,
        server: input.serverName,
        tool: input.toolName,
        arguments: boundedArgs,
      });

      const parsed = parseToolCallResponse(response);
      if (!parsed.ok) {
        return buildCodexMcpToolFailureResult({
          auditId,
          tool,
          rawMessage: parsed.message,
        });
      }

      const preview = truncateBytesUtf8(safeJson(parsed.redactedPayload), MAX_TOOL_RESULT_BYTES);

      return {
        auditId,
        selector: tool.selector,
        serverName: tool.serverName,
        toolName: tool.toolName,
        ok: true,
        redactedPreview: preview,
      };
    } catch (error) {
      return buildCodexMcpToolFailureResult({
        auditId,
        tool,
        rawMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchApps(client: CodexAppServerClientPort): Promise<CodexCatalogApp[]> {
    try {
      return await this.fetchPaginated(client, "app/list", parseAppsResponse);
    } catch {
      return [];
    }
  }

  private async fetchMcpTools(
    client: CodexAppServerClientPort,
    apps: CodexCatalogApp[],
  ): Promise<CodexCatalogMcpTool[]> {
    try {
      return await this.fetchPaginated(client, "mcpServerStatus/list", (response) =>
        parseMcpToolsResponse(response, apps),
      );
    } catch {
      return [];
    }
  }

  private async fetchPaginated<T>(
    client: CodexAppServerClientPort,
    method: string,
    parsePage: (response: unknown) => T[],
  ): Promise<T[]> {
    const merged: T[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    while (pageCount < 20) {
      const response = await client.request<unknown>(
        method,
        cursor ? { cursor, pageToken: cursor, nextCursor: cursor } : {},
      );
      merged.push(...parsePage(response));

      const nextCursor = readNextCursor(response);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }

      cursor = nextCursor;
      pageCount += 1;
    }

    return merged;
  }
}

function parseAppsResponse(response: unknown): CodexCatalogApp[] {
  const entries = extractArray(response, ["apps", "items", "data"]);
  const apps: CodexCatalogApp[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = asString(entry.id) ?? asString(entry.appId) ?? asString(entry.name);
    const name = asString(entry.name) ?? asString(entry.title) ?? id;
    if (!id || !name) {
      continue;
    }

    apps.push({
      id,
      name,
      description: asString(entry.description) ?? asString(entry.summary),
    });
  }

  return apps;
}

function parseMcpToolsResponse(response: unknown, apps: CodexCatalogApp[]): CodexCatalogMcpTool[] {
  const servers = extractArray(response, ["servers", "mcpServers", "items", "data"]);
  const appById = new Map(apps.map((app) => [normalizeSelector(app.id), app]));
  const tools: CodexCatalogMcpTool[] = [];

  for (const serverEntry of servers) {
    if (!isRecord(serverEntry)) {
      continue;
    }

    const serverName =
      asString(serverEntry.name) ??
      asString(serverEntry.serverName) ??
      asString(serverEntry.id);
    if (!serverName) {
      continue;
    }

    const appId = asString(serverEntry.appId) ?? asString(serverEntry.app);
    const linkedApp = appId ? appById.get(normalizeSelector(appId)) : undefined;
    const toolEntries = extractArray(serverEntry, ["tools", "availableTools"]);

    for (const toolEntry of toolEntries) {
      if (!isRecord(toolEntry)) {
        continue;
      }

      const toolName = asString(toolEntry.name) ?? asString(toolEntry.toolName);
      if (!toolName) {
        continue;
      }

      const inputSchema = isRecord(toolEntry.inputSchema)
        ? toolEntry.inputSchema
        : isRecord(toolEntry.input_schema)
          ? toolEntry.input_schema
          : undefined;
      const safety = parseCodexMcpToolSafetyFields(toolEntry);

      tools.push({
        selector: buildToolSelector(serverName, toolName),
        serverName,
        toolName,
        appId: linkedApp?.id,
        appName: linkedApp?.name,
        description: asString(toolEntry.description),
        inputSchema,
        readOnly: safety.readOnly,
        destructive: safety.destructive,
        annotations: safety.annotations,
      });
    }
  }

  return tools;
}

function readNextCursor(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }

  return (
    asString(response.nextCursor) ??
    asString(response.next_cursor) ??
    asString(response.pageToken) ??
    asString(response.page_token)
  );
}

function extractArray(response: unknown, keys: string[]): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (!isRecord(response)) {
    return [];
  }

  for (const key of keys) {
    const candidate = response[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

type ParsedToolCallResponse =
  | { ok: true; redactedPayload: unknown }
  | { ok: false; message: string };

function parseToolCallResponse(response: unknown): ParsedToolCallResponse {
  const failureMessage = extractToolCallFailureMessage(response);
  if (failureMessage) {
    return { ok: false, message: failureMessage };
  }

  if (!isRecord(response)) {
    return { ok: true, redactedPayload: response };
  }

  if (response.action === "decline" || response.decision === "decline") {
    return {
      ok: false,
      message: "Codex MCP tool call requires approval; declined for v1 fail-closed policy",
    };
  }

  const content = response.content ?? response.result;
  const structuredContent = response.structuredContent ?? response.structured_content;

  return {
    ok: true,
    redactedPayload: {
      content,
      structuredContent,
    },
  };
}

function extractToolCallFailureMessage(response: unknown): string | undefined {
  if (!isRecord(response)) {
    return undefined;
  }

  if (response.isError === true) {
    return formatToolCallErrorValue(response.error) ?? "Codex MCP tool call failed";
  }

  const hasResultContent = response.content !== undefined || response.result !== undefined;
  if (!hasResultContent && response.error !== undefined && response.error !== null) {
    return formatToolCallErrorValue(response.error) ?? "Codex MCP tool call failed";
  }

  return undefined;
}

function formatToolCallErrorValue(error: unknown): string | undefined {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isRecord(error)) {
    return asString(error);
  }

  const message = asString(error.message) ?? asString(error.error);
  if (message) {
    return message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return undefined;
  }
}

function buildCodexMcpToolFailureResult(params: {
  auditId: string;
  tool: CodexCatalogMcpTool;
  rawMessage: string;
}): CodexMcpToolCallResult {
  const errorPreview = formatCodexMcpToolFailureMessage(params.rawMessage);
  return {
    auditId: params.auditId,
    selector: params.tool.selector,
    serverName: params.tool.serverName,
    toolName: params.tool.toolName,
    ok: false,
    errorPreview,
    redactedPreview: errorPreview,
  };
}

export { formatCodexMcpToolFailureMessage } from "./codex-mcp-args.js";

function valueMatchesSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}


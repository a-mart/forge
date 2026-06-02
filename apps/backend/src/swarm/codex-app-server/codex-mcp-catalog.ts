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
const CODEX_APPS_AGGREGATE_SERVER = "codex_apps";

export interface CodexCatalogApp {
  id: string;
  name: string;
  description?: string;
  pluginDisplayNames?: Record<string, string>;
}

export interface CodexCatalogPlugin {
  /** User-facing plugin slug used in @Codex mentions (typically plugin `name`). */
  selector: string;
  /** Short plugin name from app-server (e.g. fireflies). */
  name?: string;
  pluginId?: string;
  uri?: string;
  displayName: string;
  description?: string;
  enabled?: boolean;
  installed?: boolean;
  accessState?: string;
  availability?: string;
  icon?: string;
  riskHints?: string[];
  category?: string;
  marketplaceName?: string;
  marketplacePath?: string;
  relatedServerNames?: string[];
  relatedAppIds?: string[];
  /** Tool names on aggregate codex_apps server uniquely mapped to this plugin. */
  codexAppsToolNames?: string[];
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
  plugins: CodexCatalogPlugin[];
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
    const plugins = enrichPluginsFromApps(await this.fetchPlugins(client), apps);
    const tools = await this.fetchMcpTools(client, apps);
    const enrichedPlugins = enrichPluginsWithCodexAppsToolScopes(plugins, tools);
    const pickerPlugins = filterPluginsForPicker(enrichedPlugins);
    const snapshot: CodexCatalogSnapshot = {
      apps,
      plugins: pickerPlugins.slice(0, MAX_CATALOG_ENTRIES),
      tools: tools.slice(0, MAX_CATALOG_ENTRIES),
      fetchedAt: new Date().toISOString(),
    };

    this.cache = {
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
      snapshot,
    };

    return snapshot;
  }

  resolvePlugin(selector: string, snapshot?: CodexCatalogSnapshot): CodexCatalogPlugin | undefined {
    const normalized = normalizeSelector(selector);
    const catalog = snapshot ?? this.cache?.snapshot;
    if (!catalog || !normalized) {
      return undefined;
    }

    const exact = catalog.plugins.find(
      (plugin) => normalizeSelector(plugin.selector) === normalized,
    );
    if (exact) {
      return exact;
    }

    const byShortName = catalog.plugins.filter(
      (plugin) => plugin.name && normalizeSelector(plugin.name) === normalized,
    );
    if (byShortName.length === 1) {
      return byShortName[0];
    }

    const byId = catalog.plugins.filter((plugin) => {
      if (!plugin.pluginId) {
        return false;
      }
      const pluginId = normalizeSelector(plugin.pluginId);
      const idBase = normalizeSelector(plugin.pluginId.split("@")[0] ?? "");
      return pluginId === normalized || idBase === normalized;
    });
    if (byId.length === 1) {
      return byId[0];
    }

    const nameMatches = catalog.plugins.filter(
      (plugin) => normalizeSelector(plugin.displayName) === normalized,
    );
    return nameMatches.length === 1 ? nameMatches[0] : undefined;
  }

  toolMatchesPluginScope(tool: CodexCatalogMcpTool, plugin: CodexCatalogPlugin): boolean {
    return toolMatchesPluginScope(tool, plugin);
  }

  isToolSelectorAuthorized(
    requestedSelector: string,
    authorizedSelectors: string[],
    snapshot?: CodexCatalogSnapshot,
  ): boolean {
    const catalog = snapshot ?? this.cache?.snapshot;
    if (!catalog) {
      return false;
    }

    const requestedTool = this.resolveTool(requestedSelector, catalog);
    if (!requestedTool) {
      return false;
    }

    return isToolSelectorAuthorizedInCatalog(requestedTool, authorizedSelectors, catalog, this);
  }

  filterToolsForAuthorizedSelectors(
    snapshot: CodexCatalogSnapshot,
    authorizedSelectors: string[],
  ): CodexCatalogMcpTool[] {
    return filterToolsForAuthorizedSelectors(snapshot, authorizedSelectors, this);
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

    const shortName = catalog.tools.find((tool) => {
      if (normalizeSelector(tool.toolName) === normalized) {
        return true;
      }
      if (isAggregateCodexAppsServer(tool.serverName)) {
        return false;
      }
      return normalizeSelector(tool.serverName) === normalized;
    });
    if (shortName && catalog.tools.filter((tool) => normalizeSelector(tool.toolName) === normalized).length === 1) {
      return shortName;
    }

    const suffixMatches = catalog.tools.filter((tool) => {
      const server = normalizeSelector(tool.serverName);
      const name = normalizeSelector(tool.toolName);
      if (normalized === name || normalized.endsWith(`/${name}`)) {
        return true;
      }
      if (isAggregateCodexAppsServer(tool.serverName)) {
        return false;
      }
      return normalized === server;
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

  private async fetchPlugins(client: CodexAppServerClientPort): Promise<CodexCatalogPlugin[]> {
    try {
      return await this.fetchPaginated(client, "plugin/list", parsePluginsResponse);
    } catch {
      return [];
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

const PLUGIN_AVAILABILITY_BLOCKED = new Set([
  "unavailable",
  "disabled",
  "blocked",
  "error",
  "uninstalled",
  "not_available",
  "not-available",
]);

const PLUGIN_AVAILABILITY_ALLOWED = new Set(["available", "ready", "installed"]);

/** Plugins eligible for the default composer picker (enabled + available only). */
export function isPluginPickerEligible(plugin: CodexCatalogPlugin): boolean {
  if (plugin.enabled !== true) {
    return false;
  }

  return isPluginAvailabilityEligible(plugin.availability);
}

function isPluginAvailabilityEligible(availability: string | undefined): boolean {
  if (!availability) {
    return true;
  }

  const normalized = availability.trim().toLowerCase();
  if (PLUGIN_AVAILABILITY_BLOCKED.has(normalized)) {
    return false;
  }

  if (PLUGIN_AVAILABILITY_ALLOWED.has(normalized)) {
    return true;
  }

  return false;
}

function filterPluginsForPicker(plugins: CodexCatalogPlugin[]): CodexCatalogPlugin[] {
  return plugins.filter(isPluginPickerEligible);
}

function parsePluginsResponse(response: unknown): CodexCatalogPlugin[] {
  const fromMarketplaces = parseMarketplacePluginsResponse(response);
  if (fromMarketplaces.length > 0) {
    return fromMarketplaces;
  }

  const entries = extractArray(response, ["plugins", "items", "data"]);
  const plugins: CodexCatalogPlugin[] = [];

  for (const entry of entries) {
    const parsed = parsePluginEntry(entry);
    if (parsed) {
      plugins.push(parsed);
    }
  }

  return plugins;
}

function parseMarketplacePluginsResponse(response: unknown): CodexCatalogPlugin[] {
  const marketplaces = extractArray(response, ["marketplaces"]);
  const plugins: CodexCatalogPlugin[] = [];

  for (const marketplaceEntry of marketplaces) {
    if (!isRecord(marketplaceEntry)) {
      continue;
    }

    const marketplaceName = asString(marketplaceEntry.name);
    const marketplacePath = asString(marketplaceEntry.path);
    const nestedPlugins = extractArray(marketplaceEntry, ["plugins"]);

    for (const pluginEntry of nestedPlugins) {
      const parsed = parsePluginEntry(pluginEntry, { marketplaceName, marketplacePath });
      if (parsed) {
        plugins.push(parsed);
      }
    }
  }

  return plugins;
}

function parsePluginEntry(
  entry: unknown,
  marketplace?: { marketplaceName?: string; marketplacePath?: string },
): CodexCatalogPlugin | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const pluginId =
    asString(entry.id) ??
    asString(entry.pluginId) ??
    asString(entry.plugin_id) ??
    asString(entry.slug);
  const shortName = asString(entry.name);
  const iface = isRecord(entry.interface) ? entry.interface : undefined;
  const displayName =
    asString(iface?.displayName) ??
    asString(iface?.display_name) ??
    asString(entry.displayName) ??
    asString(entry.display_name) ??
    shortName ??
    asString(entry.title) ??
    pluginId;
  if (!displayName) {
    return undefined;
  }

  const selector =
    shortName ??
    (pluginId ? pluginId.split("@")[0]?.trim() : undefined) ??
    slugifyCatalogKey(displayName);
  if (!selector) {
    return undefined;
  }

  const relatedServerNames = collectStringArray(entry, [
    "serverNames",
    "server_names",
    "mcpServers",
    "mcp_servers",
    "servers",
  ]);
  const relatedAppIds = collectStringArray(entry, ["appIds", "app_ids", "apps", "linkedApps"]);

  return {
    selector,
    name: shortName,
    pluginId: pluginId ?? selector,
    uri: asString(entry.uri) ?? asString(entry.pluginUri) ?? asString(entry.plugin_uri),
    displayName,
    description:
      asString(iface?.shortDescription) ??
      asString(iface?.short_description) ??
      asString(iface?.longDescription) ??
      asString(iface?.long_description) ??
      asString(entry.description) ??
      asString(entry.summary),
    enabled: readOptionalBoolean(entry.enabled ?? entry.isEnabled ?? entry.is_enabled),
    installed: readOptionalBoolean(entry.installed ?? entry.isInstalled ?? entry.is_installed),
    accessState:
      asString(entry.accessState) ??
      asString(entry.access_state) ??
      asString(entry.state) ??
      asString(entry.status),
    availability: asString(entry.availability),
    icon:
      asString(entry.icon) ??
      asString(entry.iconUrl) ??
      asString(entry.icon_url) ??
      asString(iface?.icon) ??
      asString(iface?.logo),
    riskHints: collectPluginRiskHints(entry, iface),
    category:
      asString(iface?.category) ??
      asString(entry.category) ??
      asString(entry.kind) ??
      asString(entry.type),
    marketplaceName: marketplace?.marketplaceName,
    marketplacePath: marketplace?.marketplacePath,
    relatedServerNames,
    relatedAppIds,
  };
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

    const pluginDisplayNames = readStringRecord(entry.pluginDisplayNames ?? entry.plugin_display_names);

    apps.push({
      id,
      name,
      description: asString(entry.description) ?? asString(entry.summary),
      pluginDisplayNames,
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
    for (const toolEntry of extractToolEntriesFromServer(serverEntry)) {
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

function extractToolEntriesFromServer(serverEntry: Record<string, unknown>): Record<string, unknown>[] {
  const arrayEntries = extractArray(serverEntry, ["tools", "availableTools"]);
  const normalized: Record<string, unknown>[] = [];

  for (const entry of arrayEntries) {
    if (isRecord(entry)) {
      normalized.push(entry);
    }
  }

  if (normalized.length > 0) {
    return normalized;
  }

  const toolsValue = serverEntry.tools ?? serverEntry.availableTools;
  if (!isRecord(toolsValue)) {
    return [];
  }

  return Object.entries(toolsValue).map(([key, value]) => {
    if (isRecord(value)) {
      return {
        ...value,
        name: asString(value.name) ?? asString(value.toolName) ?? key,
        toolName: asString(value.toolName) ?? asString(value.name) ?? key,
      };
    }

    return {
      name: key,
      toolName: key,
    };
  });
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

export function isToolSelectorAuthorizedInCatalog(
  requestedTool: CodexCatalogMcpTool,
  authorizedSelectors: string[],
  catalog: CodexCatalogSnapshot,
  resolver: Pick<CodexMcpCatalog, "resolveTool" | "resolvePlugin" | "toolMatchesPluginScope">,
): boolean {
  if (authorizedSelectors.length === 0) {
    return false;
  }

  const requestedKey = normalizeSelector(requestedTool.selector);

  for (const authorized of authorizedSelectors) {
    const trimmedAuthorized = authorized.trim();
    if (!trimmedAuthorized) {
      continue;
    }

    if (trimmedAuthorized.toLowerCase() === requestedTool.selector.trim().toLowerCase()) {
      return true;
    }

    const authorizedTool = resolver.resolveTool(trimmedAuthorized, catalog);
    if (
      authorizedTool &&
      normalizeSelector(authorizedTool.selector) === requestedKey
    ) {
      return true;
    }

    const authorizedPlugin = resolver.resolvePlugin(trimmedAuthorized, catalog);
    if (authorizedPlugin && resolver.toolMatchesPluginScope(requestedTool, authorizedPlugin)) {
      return true;
    }
  }

  return false;
}

export function filterToolsForAuthorizedSelectors(
  catalog: CodexCatalogSnapshot,
  authorizedSelectors: string[],
  resolver: Pick<CodexMcpCatalog, "resolveTool" | "resolvePlugin" | "toolMatchesPluginScope">,
): CodexCatalogMcpTool[] {
  if (authorizedSelectors.length === 0) {
    return [];
  }

  const hasExplicitToolSelector = authorizedSelectors.some((selector) => selector.includes("/"));
  if (hasExplicitToolSelector) {
    return catalog.tools.filter((tool) =>
      isToolSelectorAuthorizedInCatalog(tool, authorizedSelectors, catalog, resolver),
    );
  }

  const scoped = catalog.tools.filter((tool) =>
    isToolSelectorAuthorizedInCatalog(tool, authorizedSelectors, catalog, resolver),
  );
  return scoped.length > 0 ? scoped : [];
}

function toolMatchesPluginScope(tool: CodexCatalogMcpTool, plugin: CodexCatalogPlugin): boolean {
  if (isAggregateCodexAppsServer(tool.serverName)) {
    return plugin.codexAppsToolNames?.includes(tool.toolName) ?? false;
  }

  const pluginKeys = new Set<string>();
  for (const key of [
    plugin.selector,
    plugin.name,
    plugin.pluginId,
    plugin.pluginId?.split("@")[0],
    plugin.displayName,
    slugifyCatalogKey(plugin.displayName),
    ...(plugin.relatedServerNames ?? []),
    ...(plugin.relatedAppIds ?? []),
  ]) {
    const normalized = key ? normalizeSelector(key) : undefined;
    if (normalized) {
      pluginKeys.add(normalized);
    }
  }

  const server = normalizeSelector(tool.serverName);
  const appId = tool.appId ? normalizeSelector(tool.appId) : undefined;

  if (isAggregateCodexAppsServer(server)) {
    return false;
  }

  if (pluginKeys.has(server)) {
    return true;
  }

  if (appId && pluginKeys.has(appId)) {
    return true;
  }

  return false;
}

function isAggregateCodexAppsServer(serverName: string): boolean {
  return normalizeSelector(serverName) === CODEX_APPS_AGGREGATE_SERVER;
}

function enrichPluginsFromApps(
  plugins: CodexCatalogPlugin[],
  apps: CodexCatalogApp[],
): CodexCatalogPlugin[] {
  const displayNameEntries: Array<{ key: string; displayName: string }> = [];
  for (const app of apps) {
    if (!app.pluginDisplayNames) {
      continue;
    }
    for (const [key, displayName] of Object.entries(app.pluginDisplayNames)) {
      displayNameEntries.push({ key, displayName });
    }
  }

  if (displayNameEntries.length === 0) {
    return plugins;
  }

  return plugins.map((plugin) => {
    const relatedAppIds = new Set(plugin.relatedAppIds ?? []);
    for (const { key, displayName } of displayNameEntries) {
      if (pluginMatchesAppPluginKey(plugin, key, displayName)) {
        relatedAppIds.add(key);
      }
    }

    return relatedAppIds.size > (plugin.relatedAppIds?.length ?? 0)
      ? { ...plugin, relatedAppIds: [...relatedAppIds] }
      : plugin;
  });
}

function pluginMatchesAppPluginKey(
  plugin: CodexCatalogPlugin,
  key: string,
  displayName: string,
): boolean {
  const normalizedKey = normalizeSelector(key);
  const candidates = [
    plugin.selector,
    plugin.name,
    plugin.pluginId,
    plugin.pluginId?.split("@")[0],
    plugin.displayName,
  ]
    .filter(Boolean)
    .map((value) => normalizeSelector(value!));

  if (candidates.includes(normalizedKey)) {
    return true;
  }

  return normalizeSelector(displayName) === normalizeSelector(plugin.displayName);
}

function enrichPluginsWithCodexAppsToolScopes(
  plugins: CodexCatalogPlugin[],
  tools: CodexCatalogMcpTool[],
): CodexCatalogPlugin[] {
  const codexAppsTools = tools.filter((tool) => isAggregateCodexAppsServer(tool.serverName));
  if (codexAppsTools.length === 0) {
    return plugins;
  }

  return plugins.map((plugin) => {
    const matchedToolNames = codexAppsTools
      .filter((tool) => isToolUniquelyMatchedToPlugin(tool, plugin, plugins))
      .map((tool) => tool.toolName);

    return matchedToolNames.length > 0
      ? { ...plugin, codexAppsToolNames: matchedToolNames }
      : plugin;
  });
}

function isToolUniquelyMatchedToPlugin(
  tool: CodexCatalogMcpTool,
  plugin: CodexCatalogPlugin,
  allPlugins: CodexCatalogPlugin[],
): boolean {
  const prefixes = derivePluginToolPrefixes(plugin);
  const normalizedToolName = normalizeSelector(tool.toolName);
  const matchingPrefixes = prefixes.filter((prefix) => normalizedToolName.startsWith(prefix));
  if (matchingPrefixes.length === 0) {
    return false;
  }

  for (const otherPlugin of allPlugins) {
    if (otherPlugin === plugin) {
      continue;
    }

    const otherPrefixes = derivePluginToolPrefixes(otherPlugin);
    if (otherPrefixes.some((prefix) => normalizedToolName.startsWith(prefix))) {
      return false;
    }
  }

  return true;
}

function derivePluginToolPrefixes(plugin: CodexCatalogPlugin): string[] {
  const prefixes = new Set<string>();
  for (const candidate of [
    plugin.name,
    plugin.selector,
    plugin.pluginId?.split("@")[0],
    slugifyCatalogKey(plugin.name ?? ""),
    slugifyCatalogKey(plugin.displayName),
  ]) {
    const normalized = candidate ? normalizeSelector(candidate).replace(/-/g, "_") : undefined;
    if (normalized) {
      prefixes.add(`${normalized}_`);
    }
  }

  return [...prefixes];
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = asString(entry);
    if (text) {
      record[key] = text;
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function collectStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const value = asString(entry);
        if (value) {
          values.push(value);
        }
      }
    } else {
      const value = asString(candidate);
      if (value) {
        values.push(value);
      }
    }
  }

  return values;
}

function collectPluginRiskHints(
  entry: Record<string, unknown>,
  iface?: Record<string, unknown>,
): string[] | undefined {
  const hints = new Set<string>();
  const riskKeys = [
    "riskHints",
    "risk_hints",
    "risks",
    "safetyHints",
    "safety_hints",
    "annotations",
  ];

  for (const key of riskKeys) {
    const candidate = entry[key];
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const value = asString(item);
        if (value) {
          hints.add(value);
        }
      }
    } else if (isRecord(candidate)) {
      for (const [name, value] of Object.entries(candidate)) {
        if (value === true) {
          hints.add(name);
        } else {
          const text = asString(value);
          if (text) {
            hints.add(text);
          }
        }
      }
    }
  }

  if (iface) {
    for (const keyword of collectStringArray(iface, ["keywords", "tags"])) {
      hints.add(keyword);
    }
  }

  const textBlob = [
    asString(entry.category),
    asString(entry.kind),
    asString(entry.type),
    asString(entry.description),
    asString(entry.summary),
    asString(entry.name),
    asString(iface?.category),
    asString(iface?.shortDescription),
    asString(iface?.longDescription),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const keyword of [
    "destructive",
    "write",
    "browser",
    "computer-use",
    "computer use",
    "shell",
    "execute",
  ]) {
    if (textBlob.includes(keyword)) {
      hints.add(keyword);
    }
  }

  return hints.size > 0 ? [...hints] : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function slugifyCatalogKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

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


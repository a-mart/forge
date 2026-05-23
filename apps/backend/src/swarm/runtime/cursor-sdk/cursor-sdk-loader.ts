export interface CursorSdkModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface CursorSdkMcpServerHttpConfig {
  type?: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface CursorSdkMcpServerStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type CursorSdkMcpServerConfig = CursorSdkMcpServerHttpConfig | CursorSdkMcpServerStdioConfig;
export type CursorSdkMcpServers = Record<string, CursorSdkMcpServerConfig>;

export interface CursorSdkAgentOptions {
  apiKey?: string;
  model?: CursorSdkModelSelection;
  name?: string;
  local?: {
    cwd?: string | string[];
    settingSources?: string[];
    sandboxOptions?: { enabled: boolean };
  };
  mcpServers?: CursorSdkMcpServers;
  agentId?: string;
  platform?: {
    stateRoot?: string;
    workspaceRef?: string;
    [key: string]: unknown;
  };
}

export interface CursorSdkSendOptions {
  model?: CursorSdkModelSelection;
  mcpServers?: CursorSdkMcpServers;
  onStep?: (args: { step: unknown }) => void | Promise<void>;
  onDelta?: (args: { update: unknown }) => void | Promise<void>;
  local?: { force?: boolean };
  idempotencyKey?: string;
}

export interface CursorSdkRun {
  readonly id: string;
  readonly agentId: string;
  readonly status: "running" | "finished" | "error" | "cancelled";
  stream(): AsyncGenerator<unknown, void>;
  wait(): Promise<unknown>;
  cancel(): Promise<void>;
  supports?(operation: string): boolean;
  unsupportedReason?(operation: string): string | undefined;
}

export interface CursorSdkAgent {
  readonly agentId: string;
  readonly model?: CursorSdkModelSelection;
  send(message: string | { text: string; images?: Array<{ data: string; mimeType: string }> }, options?: CursorSdkSendOptions): Promise<CursorSdkRun>;
  close(): void;
  reload?(): Promise<void>;
}

export interface CursorSdkModelListResult {
  items?: Array<{
    id: string;
    displayName?: string;
    aliases?: string[];
    parameters?: unknown[];
    variants?: unknown[];
  }>;
}

export interface CursorSdkModule {
  Agent: {
    create(options: CursorSdkAgentOptions): Promise<CursorSdkAgent>;
    resume(agentId: string, options?: CursorSdkAgentOptions): Promise<CursorSdkAgent>;
  };
  Cursor: {
    models: {
      list(options?: { apiKey?: string }): Promise<CursorSdkModelListResult | CursorSdkModelListResult["items"]>;
    };
  };
  AuthenticationError?: unknown;
  RateLimitError?: unknown;
  ConfigurationError?: unknown;
  AgentBusyError?: unknown;
  IntegrationNotConnectedError?: unknown;
  NetworkError?: unknown;
}

export class CursorSdkUnavailableError extends Error {
  readonly code = "cursor_sdk_unavailable";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorSdkUnavailableError";
  }
}

type CursorSdkImporter = (specifier: string) => Promise<unknown>;

let cachedModule: CursorSdkModule | undefined;
let importerForTests: CursorSdkImporter | undefined;

export async function loadCursorSdkModule(): Promise<CursorSdkModule> {
  if (cachedModule) {
    return cachedModule;
  }

  const specifier = "@cursor/sdk";
  const importer = importerForTests ?? ((moduleSpecifier: string) => import(moduleSpecifier));

  let loaded: unknown;
  try {
    loaded = await importer(specifier);
  } catch (error) {
    throw new CursorSdkUnavailableError(
      "Cursor SDK runtime is unavailable: @cursor/sdk could not be loaded.",
      { cause: error }
    );
  }

  if (!isCursorSdkModule(loaded)) {
    throw new CursorSdkUnavailableError(
      "Cursor SDK runtime is unavailable: @cursor/sdk did not expose the expected Agent and Cursor APIs."
    );
  }

  cachedModule = loaded;
  return loaded;
}

export function setCursorSdkImporterForTests(importer: CursorSdkImporter): void {
  importerForTests = importer;
  cachedModule = undefined;
}

export function resetCursorSdkLoaderForTests(): void {
  importerForTests = undefined;
  cachedModule = undefined;
}

function isCursorSdkModule(value: unknown): value is CursorSdkModule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    Agent?: { create?: unknown; resume?: unknown };
    Cursor?: { models?: { list?: unknown } };
  };

  return (
    typeof candidate.Agent?.create === "function" &&
    typeof candidate.Agent.resume === "function" &&
    typeof candidate.Cursor?.models?.list === "function"
  );
}

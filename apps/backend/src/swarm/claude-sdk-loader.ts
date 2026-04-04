const CLAUDE_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";
const MISSING_SDK_MESSAGE = 'Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed.';

export interface ClaudeSdkMessage extends Record<string, unknown> {
  type: string;
}

export interface ClaudeSdkUserMessage {
  type: "user";
  session_id?: string;
  parent_tool_use_id?: string | null;
  message: {
    role: "user";
    content: string | Array<Record<string, unknown>>;
  };
}

export interface ClaudeSdkQueryOptions {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  sessionId?: string;
  resume?: string;
  resumeSessionAt?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  env?: Record<string, string>;
  abortController?: AbortController;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  settingSources?: string[];
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
  [key: string]: unknown;
}

export interface ClaudeSdkQueryHandle extends AsyncIterable<ClaudeSdkMessage> {
  interrupt(): Promise<void>;
  initializationResult?(): Promise<unknown>;
  close?(): void;
  return?(value?: unknown): Promise<IteratorResult<ClaudeSdkMessage>>;
}

export interface ClaudeSdkModule {
  query(args: {
    prompt: AsyncIterable<ClaudeSdkUserMessage>;
    options: ClaudeSdkQueryOptions;
  }): ClaudeSdkQueryHandle;
}

export interface ClaudeSdkMcpHelpers {
  createSdkMcpServer(config: { name: string; version: string; tools: unknown[] }): unknown;
  tool(name: string, description: string, shape: unknown, handler: (args: unknown) => Promise<unknown>): unknown;
}

type ClaudeSdkImporter = (specifier: string) => Promise<unknown>;

const defaultImporter = new Function("specifier", "return import(specifier);") as ClaudeSdkImporter;

let importClaudeSdkImpl: ClaudeSdkImporter = defaultImporter;
let cachedModule: Record<string, unknown> | undefined;
let cachedLoad: Promise<Record<string, unknown>> | undefined;

export async function loadClaudeSdkModule(): Promise<ClaudeSdkModule> {
  const module = await loadClaudeSdkExports();

  if (typeof module.query !== "function") {
    throw new Error('Claude Agent SDK module is missing the required "query" function.');
  }

  return {
    query: module.query as ClaudeSdkModule["query"]
  };
}

export async function loadClaudeSdkMcpHelpers(): Promise<ClaudeSdkMcpHelpers> {
  const module = await loadClaudeSdkExports();

  if (typeof module.createSdkMcpServer !== "function" || typeof module.tool !== "function") {
    throw new Error("Claude Agent SDK MCP helpers are unavailable.");
  }

  return {
    createSdkMcpServer: module.createSdkMcpServer as ClaudeSdkMcpHelpers["createSdkMcpServer"],
    tool: module.tool as ClaudeSdkMcpHelpers["tool"]
  };
}

async function loadClaudeSdkExports(): Promise<Record<string, unknown>> {
  if (cachedModule) {
    return cachedModule;
  }

  if (!cachedLoad) {
    cachedLoad = importClaudeSdkImpl(CLAUDE_SDK_SPECIFIER)
      .then((imported) => {
        if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
          throw new Error("Claude Agent SDK module export is unavailable.");
        }

        cachedModule = imported as Record<string, unknown>;
        return cachedModule;
      })
      .catch((error) => {
        cachedLoad = undefined;
        if (isMissingClaudeSdk(error)) {
          throw new Error(MISSING_SDK_MESSAGE);
        }
        throw error;
      });
  }

  return cachedLoad;
}

function isMissingClaudeSdk(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

export function setClaudeSdkImporterForTests(importer: ClaudeSdkImporter): void {
  importClaudeSdkImpl = importer;
  cachedModule = undefined;
  cachedLoad = undefined;
}

export function resetClaudeSdkLoaderForTests(): void {
  importClaudeSdkImpl = defaultImporter;
  cachedModule = undefined;
  cachedLoad = undefined;
}

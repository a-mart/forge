const CLAUDE_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";
const MISSING_SDK_MESSAGE = 'Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed.';
const UNAVAILABLE_SDK_PREFIX = "Claude Agent SDK is unavailable in this environment.";

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

export class ClaudeSdkUnavailableError extends Error {
  readonly code?: string;

  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message);
    this.name = "ClaudeSdkUnavailableError";
    this.code = options?.code;
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isClaudeSdkUnavailableError(error: unknown): error is ClaudeSdkUnavailableError {
  return error instanceof ClaudeSdkUnavailableError;
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
        const unavailableError = toClaudeSdkUnavailableError(error);
        if (unavailableError) {
          throw unavailableError;
        }
        throw error;
      });
  }

  return cachedLoad;
}

function toClaudeSdkUnavailableError(error: unknown): ClaudeSdkUnavailableError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (isMissingClaudeSdk(error)) {
    return new ClaudeSdkUnavailableError(MISSING_SDK_MESSAGE, {
      cause: error,
      code
    });
  }

  if (isNativeLoadFailure(error)) {
    return new ClaudeSdkUnavailableError(`${UNAVAILABLE_SDK_PREFIX} ${error.message}`, {
      cause: error,
      code
    });
  }

  return undefined;
}

function isMissingClaudeSdk(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function isNativeLoadFailure(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ERR_DLOPEN_FAILED") {
    return true;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("dlopen") ||
    message.includes("not a valid win32 application") ||
    message.includes("compiled against a different node.js version") ||
    message.includes("the specified module could not be found")
  );
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

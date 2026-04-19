import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const MCP_PATH = "/mcp";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "forge-tools";
const SERVER_VERSION = "1.0.0";

type JsonRpcId = string | number | null;

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type McpTextContentBlock = {
  type: "text";
  text: string;
};

type McpToolResult = {
  content: McpTextContentBlock[];
  isError?: boolean;
};

interface AcpMcpBridgeDescriptor {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface AcpMcpBridgeResult {
  mcpDescriptor: AcpMcpBridgeDescriptor;
  shutdown: () => Promise<void>;
}

export async function createAcpMcpToolBridge(tools: ToolDefinition[]): Promise<AcpMcpBridgeResult> {
  const toolByName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    toolByName.set(tool.name, tool);
  }

  const sessionId = `forge-mcp-${randomUUID()}`;
  const server = createServer(async (request, response) => {
    await handleRequest(request, response, toolByName, tools, sessionId);
  });

  await listenOnLoopback(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ACP MCP bridge failed to resolve a loopback address.");
  }

  let shutdownPromise: Promise<void> | null = null;

  return {
    mcpDescriptor: {
      type: "http",
      name: SERVER_NAME,
      url: `http://127.0.0.1:${address.port}${MCP_PATH}`,
      headers: []
    },
    shutdown: async () => {
      shutdownPromise ??= closeServer(server);
      await shutdownPromise;
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  toolByName: Map<string, ToolDefinition>,
  tools: ToolDefinition[],
  sessionId: string
): Promise<void> {
  setMcpSessionIdHeader(response, sessionId);
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (pathname !== MCP_PATH) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }

  if (request.method === "GET") {
    response.statusCode = 405;
    response.setHeader("Allow", "POST");
    response.end("Method not allowed");
    return;
  }

  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, POST");
    response.end("Method not allowed");
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch {
    sendJsonRpcError(response, null, -32700, "Parse error", sessionId, 400);
    return;
  }

  if (!isPlainObject(body)) {
    sendJsonRpcError(response, null, -32600, "Invalid Request", sessionId, 400);
    return;
  }

  const id = normalizeJsonRpcId(body.id);
  const method = typeof body.method === "string" ? body.method : undefined;

  if (!method) {
    sendJsonRpcError(response, id, -32600, "Invalid Request", sessionId, 400);
    return;
  }

  switch (method) {
    case "initialize":
      sendJsonRpcResult(response, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }, sessionId);
      return;
    case "notifications/initialized":
      response.statusCode = 202;
      response.end();
      return;
    case "tools/list":
      sendJsonRpcResult(response, id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? tool.label ?? `Run ${tool.name}`,
          inputSchema: cloneJsonSchema(getToolInputSchema(tool))
        }))
      }, sessionId);
      return;
    case "tools/call": {
      const result = await handleToolCall(body.params, toolByName);
      sendJsonRpcResult(response, id, result, sessionId);
      return;
    }
    default:
      sendJsonRpcError(response, id, -32601, `Method not found: ${method}`, sessionId, 404);
  }
}

async function handleToolCall(
  params: unknown,
  toolByName: Map<string, ToolDefinition>
): Promise<McpToolResult> {
  if (!isPlainObject(params) || typeof params.name !== "string") {
    return formatToolError("Invalid tools/call params.");
  }

  const definition = toolByName.get(params.name);
  if (!definition) {
    return formatToolError(`Unknown tool: ${params.name}`);
  }

  try {
    const result = await definition.execute(
      randomUUID().slice(0, 12),
      normalizeToolArguments(params.arguments),
      undefined,
      undefined,
      undefined as never
    );

    return formatToolResult(result, definition.name);
  } catch (error) {
    return formatToolError(
      `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function getToolInputSchema(toolDefinition: ToolDefinition): unknown {
  const maybeSchema = toolDefinition as ToolDefinition & {
    inputSchema?: unknown;
    parameters?: unknown;
  };

  return maybeSchema.parameters ?? maybeSchema.inputSchema ?? { type: "object", properties: {} };
}

function cloneJsonSchema(schema: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return {
      type: "object",
      additionalProperties: true
    };
  }
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }

  return value;
}

function formatToolResult(result: unknown, toolName: string): McpToolResult {
  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }]
    };
  }

  if (result === undefined) {
    return {
      content: [{ type: "text", text: `Tool ${toolName} completed.` }]
    };
  }

  return {
    content: [{ type: "text", text: safeSerialize(result) }]
  };
}

function formatToolError(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sendJsonRpcResult(response: ServerResponse, id: JsonRpcId, result: unknown, sessionId: string): void {
  sendJson(response, 200, {
    jsonrpc: "2.0",
    id,
    result
  }, sessionId);
}

function sendJsonRpcError(
  response: ServerResponse,
  id: JsonRpcId,
  code: number,
  message: string,
  sessionId: string,
  statusCode = 200
): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  }, sessionId);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: JsonRpcResponse,
  sessionId: string
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  setMcpSessionIdHeader(response, sessionId);
  response.end(JSON.stringify(payload));
}

function setMcpSessionIdHeader(response: ServerResponse, sessionId: string): void {
  response.setHeader("mcp-session-id", sessionId);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function normalizeJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

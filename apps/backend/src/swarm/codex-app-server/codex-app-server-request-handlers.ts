import type { JsonRpcRequestMessage } from "../stdio-jsonrpc-client.js";

export interface CodexCommandExecutionApprovalResponse {
  decision: "decline";
}

export interface CodexFileChangeApprovalResponse {
  decision: "decline";
}

export interface CodexMcpServerElicitationResponse {
  action: "decline";
}

export type CodexAppServerServerRequestResult =
  | CodexCommandExecutionApprovalResponse
  | CodexFileChangeApprovalResponse
  | CodexMcpServerElicitationResponse
  | Record<string, never>;

export function handleCodexAppServerServerRequest(
  request: Pick<JsonRpcRequestMessage, "method" | "params">,
): CodexAppServerServerRequestResult {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };

    case "item/fileChange/requestApproval":
      return { decision: "decline" };

    case "mcpServer/elicitation/request":
      return { action: "decline" };

    default:
      throw new Error(`Unsupported Codex app-server server request: ${request.method}`);
  }
}

export function isSupportedCodexAppServerServerRequest(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "mcpServer/elicitation/request"
  );
}

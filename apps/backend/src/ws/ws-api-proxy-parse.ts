import type {
  TerminalCreateRequest,
  TerminalIssueTicketRequest,
  TerminalRenameRequest,
  TerminalResizeRequest,
} from "@forge/protocol";

export function parseApiProxyPath(path: string): { ok: true; pathname: string } | { ok: false; error: string } {
  const normalized = path.trim();
  if (!normalized || !normalized.startsWith("/")) {
    return { ok: false, error: "api_proxy.path must start with /" };
  }

  try {
    const requestUrl = new URL(normalized, "http://api-proxy.local");
    return {
      ok: true,
      pathname: requestUrl.pathname
    };
  } catch {
    return { ok: false, error: "api_proxy.path must be a valid URL path" };
  }
}

export function parseApiProxyBody(body: string | undefined): unknown {
  if (body === undefined) {
    return {};
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function parseCompactCustomInstructionsBody(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const customInstructions = value.customInstructions;
  if (customInstructions === undefined) {
    return undefined;
  }

  if (typeof customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }

  const trimmed = customInstructions.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseApiProxyTerminalCreateBody(value: unknown): TerminalCreateRequest {
  const record = requireApiProxyRecord(value, "Terminal create body must be an object.");
  const shellArgs = record.shellArgs;
  if (shellArgs !== undefined && (!Array.isArray(shellArgs) || shellArgs.some((entry) => typeof entry !== "string"))) {
    throw new Error("shellArgs must be an array of strings.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    name: optionalApiProxyTerminalName(record),
    shell: optionalApiProxyBodyString(record, "shell"),
    shellArgs: shellArgs as string[] | undefined,
    cwd: optionalApiProxyBodyString(record, "cwd"),
    cols: optionalApiProxyBodyInteger(record, "cols"),
    rows: optionalApiProxyBodyInteger(record, "rows"),
  };
}

export function parseApiProxyTerminalRenameBody(value: unknown): TerminalRenameRequest {
  const record = requireApiProxyRecord(value, "Terminal rename body must be an object.");
  const name = optionalApiProxyBodyString(record, "title") ?? optionalApiProxyBodyString(record, "name");
  if (!name) {
    throw new Error("title must be a non-empty string.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    name,
  };
}

export function parseApiProxyTerminalResizeBody(value: unknown): TerminalResizeRequest {
  const record = requireApiProxyRecord(value, "Terminal resize body must be an object.");
  const cols = record.cols;
  const rows = record.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error("cols and rows must be integers.");
  }

  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
    cols: cols as number,
    rows: rows as number,
  };
}

export function parseApiProxyTerminalIssueTicketBody(value: unknown): TerminalIssueTicketRequest {
  const record = requireApiProxyRecord(value, "Terminal ticket body must be an object.");
  return {
    sessionAgentId: requireApiProxyBodyString(record, "sessionAgentId"),
  };
}

export function requireApiProxyRecord(input: unknown, message: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(message);
  }

  return input;
}

export function requireApiProxyBodyString(record: Record<string, unknown>, field: string): string {
  const value = optionalApiProxyBodyString(record, field);
  if (!value) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

export function optionalApiProxyBodyString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalApiProxyBodyInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }

  return value as number;
}

export function optionalApiProxyTerminalName(record: Record<string, unknown>): string | undefined {
  return optionalApiProxyBodyString(record, "title") ?? optionalApiProxyBodyString(record, "name");
}

export function requireApiProxyQueryString(requestUrl: URL, field: string): string {
  const value = requestUrl.searchParams.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

export function decodeApiProxyPathSegment(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeReasonCodes(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("reasonCodes must be an array of strings.");
  }

  const reasonCodes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("reasonCodes must be an array of strings.");
    }

    const normalized = entry.trim();
    if (!normalized) {
      throw new Error("reasonCodes must be an array of non-empty strings.");
    }

    reasonCodes.push(normalized);
  }

  return reasonCodes;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

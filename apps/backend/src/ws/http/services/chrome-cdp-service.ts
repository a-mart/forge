import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChromeCdpEndpoint, ChromeCdpTargetInfo, ChromeCdpVersionInfo } from "@forge/protocol";
import { WebSocket, type RawData } from "ws";

const DEFAULT_CDP_TIMEOUT_MS = 5_000;

interface CdpErrorPayload {
  code?: number;
  message?: string;
}

interface CdpMessageEnvelope<TResult> {
  id?: number;
  result?: TResult;
  error?: CdpErrorPayload;
}

interface CdpTargetsResponse {
  targetInfos?: ChromeCdpTargetInfo[];
}

interface CdpBrowserContextsResponse {
  browserContextIds?: string[];
  defaultBrowserContextId?: string;
}

export async function resolveChromeCdpEndpoint(): Promise<ChromeCdpEndpoint> {
  const portFile = await findChromeDevToolsActivePortFile();
  const parsed = await parseChromeDevToolsActivePort(portFile);
  return {
    portFile,
    port: parsed.port,
    wsPath: parsed.wsPath,
    wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.wsPath}`
  };
}

export async function findChromeDevToolsActivePortFile(): Promise<string> {
  const candidates = buildPortFileCandidates();

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No DevToolsActivePort file found. Ensure Chrome is running with remote debugging enabled (chrome://inspect/#remote-debugging)."
  );
}

export async function parseChromeDevToolsActivePort(
  filePath: string
): Promise<{ port: number; wsPath: string }> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const portLine = lines[0];
  const wsPathLine = lines[1];

  if (!portLine || !wsPathLine) {
    throw new Error(`Invalid DevToolsActivePort file format: ${filePath}`);
  }

  const port = Number.parseInt(portLine, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid CDP port in DevToolsActivePort file: ${filePath}`);
  }

  const wsPath = wsPathLine.startsWith("/") ? wsPathLine : `/${wsPathLine}`;
  return { port, wsPath };
}

export async function queryChromeCdpTargets(options?: {
  timeoutMs?: number;
  endpoint?: ChromeCdpEndpoint;
}): Promise<{ endpoint: ChromeCdpEndpoint; targets: ChromeCdpTargetInfo[] }> {
  const endpoint = options?.endpoint ?? (await resolveChromeCdpEndpoint());
  const response = await sendChromeCdpCommand<CdpTargetsResponse>("Target.getTargets", undefined, {
    endpoint,
    timeoutMs: options?.timeoutMs
  });

  return {
    endpoint,
    targets: Array.isArray(response.targetInfos) ? response.targetInfos : []
  };
}

export async function queryChromeCdpVersion(options?: {
  timeoutMs?: number;
  endpoint?: ChromeCdpEndpoint;
}): Promise<{ endpoint: ChromeCdpEndpoint; version: ChromeCdpVersionInfo }> {
  const endpoint = options?.endpoint ?? (await resolveChromeCdpEndpoint());
  const version = await sendChromeCdpCommand<ChromeCdpVersionInfo>("Browser.getVersion", undefined, {
    endpoint,
    timeoutMs: options?.timeoutMs
  });

  return {
    endpoint,
    version
  };
}

export async function queryChromeBrowserContexts(options?: {
  timeoutMs?: number;
  endpoint?: ChromeCdpEndpoint;
}): Promise<{ endpoint: ChromeCdpEndpoint; defaultBrowserContextId?: string; browserContextIds: string[] }> {
  const endpoint = options?.endpoint ?? (await resolveChromeCdpEndpoint());

  const response = await sendChromeCdpCommand<CdpBrowserContextsResponse>(
    "Target.getBrowserContexts",
    undefined,
    {
      endpoint,
      timeoutMs: options?.timeoutMs
    }
  );

  return {
    endpoint,
    defaultBrowserContextId:
      typeof response.defaultBrowserContextId === "string" && response.defaultBrowserContextId.trim().length > 0
        ? response.defaultBrowserContextId
        : undefined,
    browserContextIds: Array.isArray(response.browserContextIds)
      ? response.browserContextIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : []
  };
}

export async function sendChromeCdpCommand<TResult>(
  method: string,
  params?: Record<string, unknown>,
  options?: {
    endpoint?: ChromeCdpEndpoint;
    timeoutMs?: number;
  }
): Promise<TResult> {
  const endpoint = options?.endpoint ?? (await resolveChromeCdpEndpoint());
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  const commandId = 1;

  return new Promise<TResult>((resolve, reject) => {
    const socket = new WebSocket(endpoint.wsUrl);
    let settled = false;

    const timeout = setTimeout(() => {
      fail(`Timed out connecting to Chrome CDP after ${timeoutMs}ms`);
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
    };

    const safeCloseSocket = (): void => {
      try {
        // Re-attach a no-op error handler BEFORE closing.
        // Calling close() on a CONNECTING WebSocket emits an 'error' event;
        // without a handler this becomes an unhandled error that crashes the process.
        socket.on("error", () => {});
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch {
        // Ignore close errors.
      }
    };

    const finish = (result: TResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      safeCloseSocket();
      resolve(result);
    };

    const fail = (message: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      safeCloseSocket();
      reject(new Error(message));
    };

    socket.once("open", () => {
      const payload = JSON.stringify({ id: commandId, method, params: params ?? {} });
      socket.send(payload, (error) => {
        if (error) {
          fail(`Failed to send CDP command ${method}: ${error.message}`);
        }
      });
    });

    socket.on("message", (rawData: RawData) => {
      let parsed: CdpMessageEnvelope<TResult>;

      try {
        parsed = JSON.parse(rawDataToString(rawData)) as CdpMessageEnvelope<TResult>;
      } catch {
        fail("Received invalid JSON from Chrome CDP");
        return;
      }

      if (parsed.id !== commandId) {
        return;
      }

      if (parsed.error) {
        const errorMessage =
          parsed.error.message && parsed.error.message.trim().length > 0
            ? parsed.error.message
            : `CDP command failed: ${method}`;
        fail(errorMessage);
        return;
      }

      finish((parsed.result ?? {}) as TResult);
    });

    socket.once("error", (error) => {
      fail(`Failed to connect to Chrome CDP at ${endpoint.wsUrl}: ${error.message}`);
    });

    socket.once("close", (code, reasonBuffer) => {
      if (settled) {
        return;
      }

      const reason = reasonBuffer.toString().trim();
      const details = reason ? `: ${reason}` : "";
      fail(`Chrome CDP connection closed (code ${code})${details}`);
    });
  });
}

function buildPortFileCandidates(): string[] {
  const envPortFile = process.env.CDP_PORT_FILE?.trim();
  const home = homedir();

  const macCandidate = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "DevToolsActivePort"
  );
  const windowsBase = process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
  const windowsCandidate = join(
    windowsBase,
    "Google",
    "Chrome",
    "User Data",
    "DevToolsActivePort"
  );

  const platformCandidates =
    process.platform === "win32"
      ? [windowsCandidate]
      : process.platform === "darwin"
        ? [macCandidate]
        : [macCandidate, windowsCandidate];

  const deduped = new Set<string>();
  if (envPortFile) {
    deduped.add(envPortFile);
  }

  for (const candidate of platformCandidates) {
    deduped.add(candidate);
  }

  return Array.from(deduped);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rawDataToString(rawData: RawData): string {
  if (typeof rawData === "string") {
    return rawData;
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString("utf8");
  }

  return Buffer.from(rawData).toString("utf8");
}

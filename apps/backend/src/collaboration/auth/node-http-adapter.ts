import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export function nodeRequestToWebRequest(request: IncomingMessage): Request {
  const protocol = resolveRequestProtocol(request);
  const authority = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `${protocol}://${authority}`);
  const method = request.method ?? "GET";
  const headers = nodeHeadersToWebHeaders(request.headers);

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

export async function writeWebResponseToNodeResponse(
  webResponse: Response,
  response: ServerResponse,
): Promise<void> {
  response.statusCode = webResponse.status;

  if (webResponse.statusText) {
    response.statusMessage = webResponse.statusText;
  }

  applyResponseHeaders(webResponse, response);

  if (!webResponse.body) {
    response.end();
    return;
  }

  await pipeline(Readable.fromWeb(webResponse.body as NodeReadableStream), response);
}

function applyResponseHeaders(webResponse: Response, response: ServerResponse): void {
  const responseHeaders = webResponse.headers as Headers & { getSetCookie?: () => string[] };
  const setCookieHeaders =
    typeof responseHeaders.getSetCookie === "function" ? responseHeaders.getSetCookie() : [];

  if (setCookieHeaders.length > 0) {
    response.setHeader("set-cookie", setCookieHeaders);
  } else {
    const combinedSetCookieHeader = webResponse.headers.get("set-cookie");
    if (combinedSetCookieHeader) {
      response.setHeader("set-cookie", combinedSetCookieHeader);
    }
  }

  webResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      return;
    }

    response.setHeader(key, value);
  });
}

function nodeHeadersToWebHeaders(headers: IncomingMessage["headers"]): Headers {
  const webHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        webHeaders.append(name, entry);
      }
      continue;
    }

    webHeaders.set(name, value);
  }

  return webHeaders;
}

function resolveRequestProtocol(request: IncomingMessage): "http" | "https" {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const normalizedForwardedProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const proto = normalizedForwardedProto?.split(",")[0]?.trim().toLowerCase();

  if (proto === "https") {
    return "https";
  }

  if (proto === "http") {
    return "http";
  }

  const forwardedHeader = request.headers.forwarded;
  const forwardedValue = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
  const forwardedProtoMatch = forwardedValue?.match(/proto=(https|http)/i);
  if (forwardedProtoMatch?.[1]?.toLowerCase() === "https") {
    return "https";
  }

  const originHeader = request.headers.origin;
  const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (originValue?.startsWith("https://")) {
    return "https";
  }

  return "http";
}

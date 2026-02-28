import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  normalizeMimeType,
  parseMultipartFormData,
  resolveUploadFileName
} from "../attachment-parser.js";
import {
  applyCorsHeaders,
  readRequestBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const TRANSCRIBE_ENDPOINT_PATH = "/api/transcribe";
const TRANSCRIBE_METHODS = "POST, OPTIONS";
const MAX_TRANSCRIBE_FILE_BYTES = 4_000_000;
const MAX_TRANSCRIBE_BODY_BYTES = MAX_TRANSCRIBE_FILE_BYTES + 512 * 1024;
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const ALLOWED_TRANSCRIBE_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg"
]);

export function createTranscriptionRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: TRANSCRIBE_METHODS,
      matches: (pathname) => pathname === TRANSCRIBE_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, TRANSCRIBE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, TRANSCRIBE_METHODS);
          response.setHeader("Allow", TRANSCRIBE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, TRANSCRIBE_METHODS);

        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
          sendJson(response, 400, { error: "Content-Type must be multipart/form-data" });
          return;
        }

        let rawBody: Buffer;
        try {
          rawBody = await readRequestBody(request, MAX_TRANSCRIBE_BODY_BYTES);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.toLowerCase().includes("too large")) {
            sendJson(response, 413, { error: "Audio file too large. Max size is 4MB." });
            return;
          }
          throw error;
        }

        const formData = await parseMultipartFormData(rawBody, contentType);

        const fileValue = formData.get("file");
        if (!(fileValue instanceof File)) {
          sendJson(response, 400, { error: "Missing audio file upload (field name: file)." });
          return;
        }

        if (fileValue.size === 0) {
          sendJson(response, 400, { error: "Audio file is empty." });
          return;
        }

        if (fileValue.size > MAX_TRANSCRIBE_FILE_BYTES) {
          sendJson(response, 413, { error: "Audio file too large. Max size is 4MB." });
          return;
        }

        const normalizedMimeType = normalizeMimeType(fileValue.type);
        if (normalizedMimeType && !ALLOWED_TRANSCRIBE_MIME_TYPES.has(normalizedMimeType)) {
          sendJson(response, 415, { error: "Unsupported audio format." });
          return;
        }

        const apiKey = resolveOpenAiApiKey(swarmManager);
        if (!apiKey) {
          sendJson(response, 400, { error: "OpenAI API key required — add it in Settings." });
          return;
        }

        const payload = new FormData();
        payload.set("model", OPENAI_TRANSCRIPTION_MODEL);
        payload.set("response_format", "json");
        payload.set("file", fileValue, resolveUploadFileName(fileValue));

        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), OPENAI_TRANSCRIPTION_TIMEOUT_MS);

        try {
          const upstreamResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`
            },
            body: payload,
            signal: timeoutController.signal
          });

          if (!upstreamResponse.ok) {
            const statusCode = upstreamResponse.status === 401 || upstreamResponse.status === 403 ? 401 : 502;

            sendJson(response, statusCode, {
              error:
                statusCode === 401
                  ? "OpenAI API key rejected — update it in Settings."
                  : "Transcription failed. Please try again."
            });
            return;
          }

          const result = (await upstreamResponse.json()) as { text?: unknown };
          if (typeof result.text !== "string") {
            sendJson(response, 502, { error: "Invalid transcription response." });
            return;
          }

          sendJson(response, 200, { text: result.text });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            sendJson(response, 504, { error: "Transcription timed out." });
            return;
          }

          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  ];
}

function resolveOpenAiApiKey(swarmManager: SwarmManager): string | undefined {
  const authStorage = AuthStorage.create(swarmManager.getConfig().paths.authFile);
  const credential = authStorage.get("openai-codex");
  return extractAuthCredentialToken(credential as AuthCredential | undefined);
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

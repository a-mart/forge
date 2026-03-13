import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getProfileSlashCommandsPath } from "../../swarm/data-paths.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const MANAGER_SLASH_COMMANDS_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/slash-commands$/;
const MANAGER_SLASH_COMMAND_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/slash-commands\/([^/]+)$/;
const SLASH_COMMAND_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

interface SlashCommand {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

type SlashCommandsRoute =
  | {
      managerId: string;
      kind: "collection";
    }
  | {
      managerId: string;
      kind: "item";
      commandId: string;
    };

export function createSlashCommandRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, POST, PUT, DELETE, OPTIONS",
      matches: (pathname) =>
        MANAGER_SLASH_COMMANDS_ENDPOINT_PATTERN.test(pathname) ||
        MANAGER_SLASH_COMMAND_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        const methods = "GET, POST, PUT, DELETE, OPTIONS";

        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, methods);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (
          request.method !== "GET" &&
          request.method !== "POST" &&
          request.method !== "PUT" &&
          request.method !== "DELETE"
        ) {
          applyCorsHeaders(request, response, methods);
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, methods);

        const route = resolveSlashCommandRoute(requestUrl.pathname);
        if (!route) {
          response.setHeader("Allow", methods);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const descriptor = swarmManager.getAgent(route.managerId);
        if (!descriptor || descriptor.role !== "manager") {
          sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
          return;
        }

        const profileId = descriptor.profileId ?? route.managerId;
        const slashCommandsPath = getProfileSlashCommandsPath(swarmManager.getConfig().paths.dataDir, profileId);

        if (request.method === "GET" && route.kind === "collection") {
          const commands = await readSlashCommandsFile(slashCommandsPath);
          sendJson(response, 200, { commands });
          return;
        }

        if (request.method === "POST" && route.kind === "collection") {
          const payload = await readJsonBody(request);
          const parsed = parseCreateSlashCommandBody(payload);

          const commands = await readSlashCommandsFile(slashCommandsPath);
          if (hasDuplicateSlashCommandName(commands, parsed.name)) {
            sendJson(response, 409, { error: `Slash command name already exists: ${parsed.name}` });
            return;
          }

          const now = new Date().toISOString();
          const command: SlashCommand = {
            id: randomUUID(),
            name: parsed.name,
            prompt: parsed.prompt,
            createdAt: now,
            updatedAt: now
          };

          commands.push(command);
          await writeSlashCommandsFile(slashCommandsPath, commands);
          sendJson(response, 201, { command });
          return;
        }

        if (request.method === "PUT" && route.kind === "item") {
          const payload = await readJsonBody(request);
          const patch = parseUpdateSlashCommandBody(payload);

          const commands = await readSlashCommandsFile(slashCommandsPath);
          const commandIndex = commands.findIndex((entry) => entry.id === route.commandId);
          if (commandIndex < 0) {
            sendJson(response, 404, { error: `Unknown slash command: ${route.commandId}` });
            return;
          }

          const existing = commands[commandIndex];
          const nextName = patch.name ?? existing.name;

          if (hasDuplicateSlashCommandName(commands, nextName, existing.id)) {
            sendJson(response, 409, { error: `Slash command name already exists: ${nextName}` });
            return;
          }

          const updated: SlashCommand = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            updatedAt: new Date().toISOString()
          };

          commands[commandIndex] = updated;
          await writeSlashCommandsFile(slashCommandsPath, commands);
          sendJson(response, 200, { command: updated });
          return;
        }

        if (request.method === "DELETE" && route.kind === "item") {
          const commands = await readSlashCommandsFile(slashCommandsPath);
          const commandIndex = commands.findIndex((entry) => entry.id === route.commandId);
          if (commandIndex < 0) {
            sendJson(response, 404, { error: `Unknown slash command: ${route.commandId}` });
            return;
          }

          commands.splice(commandIndex, 1);
          await writeSlashCommandsFile(slashCommandsPath, commands);
          sendJson(response, 200, { ok: true });
          return;
        }

        response.setHeader("Allow", methods);
        sendJson(response, 405, { error: "Method Not Allowed" });
      }
    }
  ];
}

function resolveSlashCommandRoute(pathname: string): SlashCommandsRoute | null {
  const collectionMatch = matchPathPattern(pathname, MANAGER_SLASH_COMMANDS_ENDPOINT_PATTERN);
  if (collectionMatch) {
    const managerId = decodePathSegment(collectionMatch[1]);
    if (!managerId) {
      return null;
    }

    return {
      managerId,
      kind: "collection"
    };
  }

  const itemMatch = matchPathPattern(pathname, MANAGER_SLASH_COMMAND_ENDPOINT_PATTERN);
  if (itemMatch) {
    const managerId = decodePathSegment(itemMatch[1]);
    const commandId = decodePathSegment(itemMatch[2]);
    if (!managerId || !commandId) {
      return null;
    }

    return {
      managerId,
      kind: "item",
      commandId
    };
  }

  return null;
}

async function readSlashCommandsFile(filePath: string): Promise<SlashCommand[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.trim().length === 0) {
      return [];
    }

    const parsed = JSON.parse(raw) as { commands?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid slash command storage format");
    }

    if (parsed.commands === undefined) {
      return [];
    }

    if (!Array.isArray(parsed.commands)) {
      throw new Error("Invalid slash command storage format: commands must be an array");
    }

    return parsed.commands.map((entry, index) => normalizeStoredSlashCommand(entry, index));
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }
}

async function writeSlashCommandsFile(filePath: string, commands: SlashCommand[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ commands }, null, 2)}\n`, "utf8");
}

function normalizeStoredSlashCommand(entry: unknown, index: number): SlashCommand {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid slash command record at index ${index}`);
  }

  const maybe = entry as Partial<SlashCommand>;

  const id = normalizeStoredRequiredString(maybe.id);
  const name = normalizeStoredRequiredString(maybe.name);
  const prompt = normalizeStoredPrompt(maybe.prompt);
  const createdAt = normalizeStoredRequiredString(maybe.createdAt);
  const updatedAt = normalizeStoredRequiredString(maybe.updatedAt);

  if (!id || !name || !prompt || !createdAt || !updatedAt) {
    throw new Error(`Invalid slash command record at index ${index}`);
  }

  if (!isValidSlashCommandName(name)) {
    throw new Error(`Invalid slash command name in storage at index ${index}`);
  }

  return {
    id,
    name,
    prompt,
    createdAt,
    updatedAt
  };
}

function normalizeStoredRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStoredPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function parseCreateSlashCommandBody(value: unknown): { name: string; prompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    name?: unknown;
    prompt?: unknown;
  };

  return {
    name: parseSlashCommandName(maybe.name),
    prompt: parseSlashCommandPrompt(maybe.prompt)
  };
}

function parseUpdateSlashCommandBody(value: unknown): { name?: string; prompt?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybe = value as {
    name?: unknown;
    prompt?: unknown;
  };

  if (maybe.name === undefined && maybe.prompt === undefined) {
    throw new Error("At least one of name or prompt must be provided");
  }

  return {
    ...(maybe.name !== undefined ? { name: parseSlashCommandName(maybe.name) } : {}),
    ...(maybe.prompt !== undefined ? { prompt: parseSlashCommandPrompt(maybe.prompt) } : {})
  };
}

function parseSlashCommandName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("name must be a string");
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("name must be a non-empty string");
  }

  if (!isValidSlashCommandName(normalized)) {
    throw new Error("name must use only alphanumeric characters, hyphens, and underscores, with no leading slash");
  }

  return normalized;
}

function parseSlashCommandPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("prompt must be a string");
  }

  if (value.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }

  return value;
}

function isValidSlashCommandName(name: string): boolean {
  if (name.startsWith("/")) {
    return false;
  }

  return SLASH_COMMAND_NAME_PATTERN.test(name);
}

function hasDuplicateSlashCommandName(commands: SlashCommand[], name: string, excludeId?: string): boolean {
  const normalizedName = normalizeSlashCommandNameForComparison(name);

  return commands.some((command) => {
    if (excludeId && command.id === excludeId) {
      return false;
    }

    return normalizeSlashCommandNameForComparison(command.name) === normalizedName;
  });
}

function normalizeSlashCommandNameForComparison(name: string): string {
  return name.trim().toLowerCase();
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

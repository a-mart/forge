import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getGlobalSlashCommandsPath, getProfilesDir } from "../../swarm/data-paths.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import {
  applyCorsHeaders,
  decodePathSegment,
  matchPathPattern,
  readJsonBody,
  sendJson
} from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const GLOBAL_SLASH_COMMANDS_ENDPOINT_PATTERN = /^\/api\/slash-commands$/;
const GLOBAL_SLASH_COMMAND_ENDPOINT_PATTERN = /^\/api\/slash-commands\/([^/]+)$/;
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
      kind: "collection";
    }
  | {
      kind: "item";
      commandId: string;
    };

/**
 * Migrates profile-scoped slash commands to the global location.
 * This is a one-time migration that merges all profile-scoped slash-commands.json
 * files into the shared/slash-commands.json file.
 */
async function migrateProfileSlashCommandsToGlobal(dataDir: string): Promise<void> {
  const globalPath = getGlobalSlashCommandsPath(dataDir);
  const profilesDir = getProfilesDir(dataDir);

  // Check if global file already exists with content - if so, migration already done
  const existingGlobal = await readSlashCommandsFile(globalPath);
  if (existingGlobal.length > 0) {
    return;
  }

  // Find all profile directories
  let profileDirs: string[] = [];
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    profileDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      // No profiles directory yet - nothing to migrate
      return;
    }
    throw error;
  }

  // Collect all slash commands from profile directories
  const allCommands: SlashCommand[] = [];
  const seenNames = new Set<string>();

  for (const profileId of profileDirs) {
    const profileSlashCommandsPath = join(profilesDir, profileId, "slash-commands.json");
    try {
      const profileCommands = await readSlashCommandsFile(profileSlashCommandsPath);
      
      for (const command of profileCommands) {
        const normalizedName = normalizeSlashCommandNameForComparison(command.name);
        if (!seenNames.has(normalizedName)) {
          allCommands.push(command);
          seenNames.add(normalizedName);
        }
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        console.error(`Failed to read slash commands from profile ${profileId}:`, error);
      }
      // Continue with other profiles even if one fails
    }
  }

  // Write merged commands to global location if we found any
  if (allCommands.length > 0) {
    await writeSlashCommandsFile(globalPath, allCommands);
    console.log(`Migrated ${allCommands.length} slash command(s) to global storage`);
  }
}

export function createSlashCommandRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  // Run migration asynchronously (fire and forget - will complete before first request)
  void migrateProfileSlashCommandsToGlobal(swarmManager.getConfig().paths.dataDir);

  return [
    {
      methods: "GET, POST, PUT, DELETE, OPTIONS",
      matches: (pathname) =>
        GLOBAL_SLASH_COMMANDS_ENDPOINT_PATTERN.test(pathname) ||
        GLOBAL_SLASH_COMMAND_ENDPOINT_PATTERN.test(pathname),
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

        const slashCommandsPath = getGlobalSlashCommandsPath(swarmManager.getConfig().paths.dataDir);

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
  const collectionMatch = matchPathPattern(pathname, GLOBAL_SLASH_COMMANDS_ENDPOINT_PATTERN);
  if (collectionMatch) {
    return {
      kind: "collection"
    };
  }

  const itemMatch = matchPathPattern(pathname, GLOBAL_SLASH_COMMAND_ENDPOINT_PATTERN);
  if (itemMatch) {
    const commandId = decodePathSegment(itemMatch[1]);
    if (!commandId) {
      return null;
    }

    return {
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

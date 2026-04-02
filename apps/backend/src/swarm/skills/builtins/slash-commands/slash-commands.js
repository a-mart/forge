#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const SLASH_COMMAND_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function resolveDataDir() {
  return process.env.SWARM_DATA_DIR || resolve(homedir(), ".forge");
}

function resolveSlashCommandsFilePath(dataDir) {
  return resolve(dataDir, "shared", "config", "slash-commands.json");
}

function printJson(payload) {
  console.log(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv) {
  const command = argv[0];
  const flags = new Map();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (!key) {
      throw new Error("Invalid argument: --");
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    flags.set(key, value);
    index += 1;
  }

  return { command, flags };
}

function getRequiredFlag(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }

  return value;
}

function parseSlashCommandId(value) {
  if (typeof value !== "string") {
    throw new Error("id must be a string");
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("id must be a non-empty string");
  }

  return normalized;
}

function parseSlashCommandName(value) {
  if (typeof value !== "string") {
    throw new Error("name must be a string");
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("name must be a non-empty string");
  }

  if (!isValidSlashCommandName(normalized)) {
    throw new Error(
      "name must use only alphanumeric characters, hyphens, and underscores, with no leading slash"
    );
  }

  return normalized;
}

function parseSlashCommandPrompt(value) {
  if (typeof value !== "string") {
    throw new Error("prompt must be a string");
  }

  if (value.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }

  return value;
}

function parseSelector(flags) {
  const id = flags.get("id");
  const name = flags.get("name");

  if (id !== undefined && name !== undefined) {
    throw new Error("Provide either --id or --name, not both");
  }

  if (id !== undefined) {
    return {
      type: "id",
      value: parseSlashCommandId(id)
    };
  }

  if (name !== undefined) {
    return {
      type: "name",
      value: parseSlashCommandName(name)
    };
  }

  throw new Error("Missing selector. Provide --id or --name");
}

function isValidSlashCommandName(name) {
  if (name.startsWith("/")) {
    return false;
  }

  return SLASH_COMMAND_NAME_PATTERN.test(name);
}

function normalizeSlashCommandNameForComparison(name) {
  return name.trim().toLowerCase();
}

function hasDuplicateSlashCommandName(commands, name, excludeId) {
  const normalizedName = normalizeSlashCommandNameForComparison(name);

  return commands.some((command) => {
    if (excludeId && command.id === excludeId) {
      return false;
    }

    return normalizeSlashCommandNameForComparison(command.name) === normalizedName;
  });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoredRequiredString(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStoredPrompt(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length > 0 ? value : undefined;
}

function normalizeStoredSlashCommand(entry, index) {
  if (!isObject(entry)) {
    throw new Error(`Invalid slash command record at index ${index}`);
  }

  const id = normalizeStoredRequiredString(entry.id);
  const name = normalizeStoredRequiredString(entry.name);
  const prompt = normalizeStoredPrompt(entry.prompt);
  const createdAt = normalizeStoredRequiredString(entry.createdAt);
  const updatedAt = normalizeStoredRequiredString(entry.updatedAt);

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

async function readSlashCommandsFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    if (raw.trim().length === 0) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
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

async function writeSlashCommandsFile(filePath, commands) {
  await mkdir(dirname(filePath), { recursive: true });

  const tempFile = `${filePath}.tmp`;
  await writeFile(tempFile, `${JSON.stringify({ commands }, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function findCommandIndex(commands, selector) {
  if (selector.type === "id") {
    return commands.findIndex((command) => command.id === selector.value);
  }

  const normalizedName = normalizeSlashCommandNameForComparison(selector.value);
  const matches = [];

  for (let index = 0; index < commands.length; index += 1) {
    if (normalizeSlashCommandNameForComparison(commands[index].name) === normalizedName) {
      matches.push(index);
    }
  }

  if (matches.length > 1) {
    throw new Error(`Multiple slash commands match name: ${selector.value}`);
  }

  return matches[0] ?? -1;
}

async function handleList(filePath) {
  const commands = await readSlashCommandsFile(filePath);

  printJson({
    ok: true,
    action: "list",
    count: commands.length,
    commands,
    filePath
  });
}

async function handleCreate(flags, filePath) {
  const name = parseSlashCommandName(getRequiredFlag(flags, "name"));
  const prompt = parseSlashCommandPrompt(getRequiredFlag(flags, "prompt"));

  const commands = await readSlashCommandsFile(filePath);
  if (hasDuplicateSlashCommandName(commands, name)) {
    throw new Error(`Slash command name already exists: ${name}`);
  }

  const now = new Date().toISOString();
  const command = {
    id: randomUUID(),
    name,
    prompt,
    createdAt: now,
    updatedAt: now
  };

  commands.push(command);
  await writeSlashCommandsFile(filePath, commands);

  printJson({
    ok: true,
    action: "create",
    command,
    filePath
  });
}

async function handleUpdate(flags, filePath) {
  const selector = parseSelector(flags);
  const nextNameRaw = flags.get("new-name");
  const nextPromptRaw = flags.get("prompt");

  if (nextNameRaw === undefined && nextPromptRaw === undefined) {
    throw new Error("Provide at least one field to update: --new-name and/or --prompt");
  }

  const patch = {
    ...(nextNameRaw !== undefined ? { name: parseSlashCommandName(nextNameRaw) } : {}),
    ...(nextPromptRaw !== undefined ? { prompt: parseSlashCommandPrompt(nextPromptRaw) } : {})
  };

  const commands = await readSlashCommandsFile(filePath);
  const commandIndex = findCommandIndex(commands, selector);
  if (commandIndex < 0) {
    throw new Error(`Unknown slash command: ${selector.value}`);
  }

  const existing = commands[commandIndex];
  const nextName = patch.name ?? existing.name;

  if (hasDuplicateSlashCommandName(commands, nextName, existing.id)) {
    throw new Error(`Slash command name already exists: ${nextName}`);
  }

  const updated = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
    updatedAt: new Date().toISOString()
  };

  commands[commandIndex] = updated;
  await writeSlashCommandsFile(filePath, commands);

  printJson({
    ok: true,
    action: "update",
    matchedBy: selector.type,
    command: updated,
    filePath
  });
}

async function handleDelete(flags, filePath) {
  const selector = parseSelector(flags);

  const commands = await readSlashCommandsFile(filePath);
  const commandIndex = findCommandIndex(commands, selector);
  if (commandIndex < 0) {
    throw new Error(`Unknown slash command: ${selector.value}`);
  }

  const [removed] = commands.splice(commandIndex, 1);
  await writeSlashCommandsFile(filePath, commands);

  printJson({
    ok: true,
    action: "delete",
    matchedBy: selector.type,
    command: removed,
    filePath
  });
}

function printUsage() {
  printJson({
    ok: false,
    error: "Usage: slash-commands.js <list|create|update|delete> [options]",
    commands: {
      list: "slash-commands.js list",
      create: 'slash-commands.js create --name "my-command" --prompt "My prompt"',
      updateById:
        'slash-commands.js update --id "<command-id>" [--new-name "new-name"] [--prompt "Updated prompt"]',
      updateByName:
        'slash-commands.js update --name "existing-name" [--new-name "new-name"] [--prompt "Updated prompt"]',
      deleteById: 'slash-commands.js delete --id "<command-id>"',
      deleteByName: 'slash-commands.js delete --name "existing-name"'
    }
  });
}

function isEnoentError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  const dataDir = resolveDataDir();
  const slashCommandsFilePath = resolveSlashCommandsFilePath(dataDir);

  switch (command) {
    case "list":
      await handleList(slashCommandsFilePath);
      return;

    case "create":
      await handleCreate(flags, slashCommandsFilePath);
      return;

    case "update":
      await handleUpdate(flags, slashCommandsFilePath);
      return;

    case "delete":
      await handleDelete(flags, slashCommandsFilePath);
      return;

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printJson({
    ok: false,
    error: message
  });
  process.exitCode = 1;
});

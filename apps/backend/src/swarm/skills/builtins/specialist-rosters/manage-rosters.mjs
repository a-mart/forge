#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const BOOLEAN_FLAGS = new Set(["apply"]);
const COMMAND_FLAGS = {
  list: new Set(["url"]),
  show: new Set(["id", "url"]),
  models: new Set(["url"]),
  create: new Set(["file", "apply", "url"]),
  update: new Set(["id", "expected-revision", "file", "apply", "url"]),
};

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage() {
  return [
    "Usage:",
    "  manage-rosters.mjs list [--url <forge-base-url>]",
    "  manage-rosters.mjs show --id <roster-id> [--url <forge-base-url>]",
    "  manage-rosters.mjs models [--url <forge-base-url>]",
    "  manage-rosters.mjs create --file <roster.json|-> [--apply] [--url <forge-base-url>]",
    "  manage-rosters.mjs update --id <roster-id> --expected-revision <n> --file <roster.json|-> [--apply] [--url <forge-base-url>]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) {
    throw new Error(`${usage()}\n\nUnknown or missing command: ${command ?? "<none>"}`);
  }

  const flags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option for ${command}: --${key}`);
    if (flags.has(key)) throw new Error(`Duplicate option: --${key}`);

    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    index += 1;
  }

  return { command, flags };
}

function requiredString(flags, name) {
  const value = flags.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value.trim();
}

function parseExpectedRevision(flags) {
  const raw = requiredString(flags, "expected-revision");
  const revision = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("--expected-revision must be a positive integer");
  }
  return revision;
}

function resolveBaseUrl(flags) {
  const explicit = flags.get("url");
  const candidate = typeof explicit === "string" && explicit.trim().length > 0
    ? explicit.trim()
    : `http://127.0.0.1:${process.env.FORGE_PORT ?? process.env.MIDDLEMAN_PORT ?? "47187"}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid Forge base URL: ${candidate}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Forge base URL must use http or https");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Forge base URL must target the local Forge instance");
  }
  return url;
}

function endpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl);
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(`Could not reach Forge at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await response.text();
  let payload = {};
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Forge returned a non-JSON response (${response.status})`);
    }
  }

  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof payload.error === "string"
      ? payload.error
      : `Forge request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function readRosterFile(filePath) {
  const raw = filePath === "-"
    ? await readStdin()
    : await readFile(resolve(filePath), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Roster file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Roster file must contain one JSON object");
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function storagePath() {
  const dataDir = process.env.SWARM_DATA_DIR
    || process.env.FORGE_DATA_DIR
    || resolve(homedir(), ".forge");
  return resolve(dataDir, "shared", "config", "delegation-rosters.json");
}

function assertSettings(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rosters)) {
    throw new Error("Forge returned invalid roster settings");
  }
  return payload;
}

function findRoster(settings, rosterId) {
  const roster = settings.rosters.find((candidate) => candidate?.rosterId === rosterId);
  if (!roster) throw new Error(`Unknown roster: ${rosterId}`);
  return roster;
}

function proposalForCreate(input) {
  const rosterId = typeof input.rosterId === "string" ? input.rosterId.trim() : "";
  if (!rosterId) throw new Error("Roster proposal must include rosterId");
  return { ...input, rosterId, revision: 1 };
}

function proposalForUpdate(input, current) {
  if (
    input.rosterId !== undefined
    && (typeof input.rosterId !== "string" || input.rosterId.trim() !== current.rosterId)
  ) {
    throw new Error(`Roster proposal rosterId must remain ${current.rosterId} for this update`);
  }
  return {
    ...input,
    rosterId: current.rosterId,
    revision: current.revision,
  };
}

async function saveSettings(baseUrl, settings) {
  return assertSettings(await requestJson(endpoint(baseUrl, "/api/settings/delegation-rosters"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  }));
}

function rosterSummary(roster) {
  return {
    rosterId: roster.rosterId,
    name: roster.name,
    revision: roster.revision,
    specialists: Array.isArray(roster.routes)
      ? roster.routes.map((route) => ({
          routeId: route.routeId,
          label: route.label,
          behaviorMode: route.behaviorMode,
          provider: route.provider,
          modelId: route.modelId,
          reasoningLevel: route.reasoningLevel,
        }))
      : [],
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const baseUrl = resolveBaseUrl(flags);

  if (command === "models") {
    const payload = await requestJson(endpoint(baseUrl, "/api/settings/models"));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    printJson({
      ok: true,
      models: models.map((model) => ({
        provider: model.provider,
        modelId: model.modelId,
        displayName: model.displayName,
        defaultReasoningLevel: model.defaultReasoningLevel,
        supportedReasoningLevels: model.supportedReasoningLevels,
        ...(Array.isArray(model.variants) && model.variants.length > 0 ? { variants: model.variants } : {}),
      })),
    });
    return;
  }

  const settings = assertSettings(await requestJson(endpoint(baseUrl, "/api/settings/delegation-rosters")));

  if (command === "list") {
    printJson({
      ok: true,
      defaultRosterId: settings.defaultRosterId,
      storagePath: storagePath(),
      rosters: settings.rosters.map(rosterSummary),
    });
    return;
  }

  if (command === "show") {
    const roster = findRoster(settings, requiredString(flags, "id"));
    printJson({ ok: true, storagePath: storagePath(), roster });
    return;
  }

  const input = await readRosterFile(requiredString(flags, "file"));
  const apply = flags.get("apply") === true;

  if (command === "create") {
    const proposal = proposalForCreate(input);
    if (settings.rosters.some((preset) => preset?.rosterId === proposal.rosterId)) {
      throw new Error(`Roster already exists: ${proposal.rosterId}`);
    }
    if (!apply) {
      printJson({ ok: true, action: "preview_create", storagePath: storagePath(), proposal });
      return;
    }
    const saved = await saveSettings(baseUrl, {
      ...settings,
      rosters: [...settings.rosters, proposal],
    });
    printJson({
      ok: true,
      action: "created",
      storagePath: storagePath(),
      roster: findRoster(saved, proposal.rosterId),
    });
    return;
  }

  const rosterId = requiredString(flags, "id");
  const expectedRevision = parseExpectedRevision(flags);
  const current = findRoster(settings, rosterId);
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Roster ${rosterId} changed: expected revision ${expectedRevision}, current revision is ${current.revision}`,
    );
  }
  const proposal = proposalForUpdate(input, current);
  if (!apply) {
    printJson({
      ok: true,
      action: "preview_update",
      storagePath: storagePath(),
      current,
      proposal,
    });
    return;
  }
  const saved = await saveSettings(baseUrl, {
    ...settings,
    rosters: settings.rosters.map((roster) => roster.rosterId === rosterId ? proposal : roster),
  });
  printJson({
    ok: true,
    action: "updated",
    storagePath: storagePath(),
    roster: findRoster(saved, rosterId),
  });
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

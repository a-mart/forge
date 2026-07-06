import { resolve } from "node:path";
import { KnowledgeService } from "../apps/backend/src/swarm/knowledge-service.js";
import { KnowledgeV2SettingsService } from "../apps/backend/src/swarm/knowledge-v2-settings-service.js";
import {
  cleanupLegacyKnowledgeFiles,
  rollbackKnowledgeV2Migration,
  runKnowledgeV2Migration,
} from "../apps/backend/src/swarm/knowledge-v2-migration-service.js";

const args = new Set(process.argv.slice(2));
const dataDirArg = readFlag("--data-dir");
const dataDir = resolve(dataDirArg ?? process.env.FORGE_DATA_DIR ?? process.env.MIDDLEMAN_DATA_DIR ?? "");

if (!dataDirArg && !process.env.FORGE_DATA_DIR && !process.env.MIDDLEMAN_DATA_DIR) {
  fail("Pass --data-dir or set FORGE_DATA_DIR. Live default data-dir migration is intentionally not implicit.");
}

const settingsService = new KnowledgeV2SettingsService({ dataDir });
await settingsService.load();
const knowledgeService = new KnowledgeService({ dataDir, settingsService });

if (args.has("--rollback")) {
  const result = await rollbackKnowledgeV2Migration({
    dataDir,
    settingsService,
    knowledgeService,
    manifestPath: readFlag("--manifest"),
  });
  console.log(JSON.stringify(result, null, 2));
} else if (args.has("--cleanup-legacy")) {
  const result = await cleanupLegacyKnowledgeFiles({
    dataDir,
    settingsService,
    confirm: args.has("--confirm"),
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  const manifest = await runKnowledgeV2Migration({
    dataDir,
    settingsService,
    knowledgeService,
    force: args.has("--force"),
  });
  console.log(JSON.stringify({
    migrationId: manifest.migrationId,
    files: manifest.files,
    entries: manifest.entries.length,
    discards: manifest.discards.length,
    indexResults: manifest.indexResults,
  }, null, 2));
}

function readFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${name} requires a value.`);
  }
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

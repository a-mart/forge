import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { migrateDataDirectory } from "../apps/backend/src/swarm/data-migration.ts";
import { getSessionFilePath, getWorkerSessionFilePath } from "../apps/backend/src/swarm/data-paths.ts";

const DEFAULT_SOURCE_DATA_DIR = "/Users/adam/repos/middleman-data-restructure/.middleman-test";

type AgentRole = "manager" | "worker";

interface AgentModelLike {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

interface AgentDescriptorLike {
  agentId: string;
  displayName?: string;
  role: AgentRole;
  managerId: string;
  profileId?: string;
  status?: string;
  createdAt: string;
  updatedAt: string;
  cwd?: string;
  model: AgentModelLike;
  sessionFile: string;
  sessionLabel?: string;
}

interface ManagerProfileLike {
  profileId: string;
  displayName: string;
  defaultSessionAgentId: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentsStoreLike {
  agents?: AgentDescriptorLike[];
  profiles?: ManagerProfileLike[];
}

interface CapturedLog {
  level: "debug" | "info" | "warn";
  message: string;
  details?: unknown;
}

interface CheckResult {
  name: string;
  pass: boolean;
  details?: string;
}

interface WorkingCopyStats {
  sourceSessionCount: number;
  sourceMemoryCount: number;
  dummySessionCount: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const sourceDataDir = process.env.MIDDLEMAN_TEST_DATA_DIR ?? DEFAULT_SOURCE_DATA_DIR;
  const checks: CheckResult[] = [];
  const migrationLogs: CapturedLog[] = [];

  let tempDataDir: string | null = null;
  let sourceSessionCount = 0;
  let sourceMemoryCount = 0;
  let dummySessionCount = 0;
  let firstMigrationRan = false;
  let secondMigrationSkipped = false;
  let fatalError: string | null = null;

  try {
    const sourceExists = await pathExists(sourceDataDir);
    addCheck(
      checks,
      "Source data directory exists",
      sourceExists,
      sourceExists ? sourceDataDir : `Missing: ${sourceDataDir}`
    );

    if (!sourceExists) {
      return;
    }

    tempDataDir = await fs.mkdtemp(join(tmpdir(), "middleman-migration-test-"));

    const copyStats = await createWorkingCopy(sourceDataDir, tempDataDir);
    sourceSessionCount = copyStats.sourceSessionCount;
    sourceMemoryCount = copyStats.sourceMemoryCount;
    dummySessionCount = copyStats.dummySessionCount;

    addCheck(
      checks,
      "Working copy created with dummy session files",
      copyStats.sourceSessionCount > 0 && copyStats.sourceSessionCount === copyStats.dummySessionCount,
      `sourceSessions=${copyStats.sourceSessionCount}, dummySessions=${copyStats.dummySessionCount}`
    );

    const agentsStoreFile = join(tempDataDir, "swarm", "agents.json");
    const loadedStore = (await readJson(agentsStoreFile)) as AgentsStoreLike;
    const loadedAgents = Array.isArray(loadedStore.agents) ? loadedStore.agents : [];
    const derivedProfiles = deriveProfilesFromAgents(loadedAgents);

    addCheck(
      checks,
      "Loaded agents from working copy",
      loadedAgents.length > 0,
      `agents=${loadedAgents.length}, derivedProfiles=${derivedProfiles.length}`
    );

    const hasRequiredProfiles =
      derivedProfiles.some((profile) => profile.profileId === "feature-manager") &&
      derivedProfiles.some((profile) => profile.profileId === "middleman-project");

    addCheck(
      checks,
      "Derived profiles include feature-manager and middleman-project",
      hasRequiredProfiles,
      `profiles=[${derivedProfiles.map((profile) => profile.profileId).join(", ")}]`
    );

    const logger = {
      debug: (message: string, details?: unknown) => {
        migrationLogs.push({ level: "debug", message, details });
      },
      info: (message: string, details?: unknown) => {
        migrationLogs.push({ level: "info", message, details });
      },
      warn: (message: string, details?: unknown) => {
        migrationLogs.push({ level: "warn", message, details });
      }
    };

    const firstMigration = await migrateDataDirectory(
      {
        dataDir: tempDataDir,
        agentsStoreFile
      },
      loadedAgents as never,
      derivedProfiles as never,
      logger
    );

    firstMigrationRan = firstMigration.migrated;

    addCheck(
      checks,
      "First migration run executed",
      firstMigration.migrated,
      `migrated=${firstMigration.migrated}, updatedAgents=${firstMigration.updatedAgents.length}`
    );

    const migratedStore = (await readJson(agentsStoreFile)) as AgentsStoreLike;
    const migratedAgents = Array.isArray(migratedStore.agents) ? migratedStore.agents : [];

    await runPostMigrationChecks({
      checks,
      dataDir: tempDataDir,
      sourceSessionCount,
      sourceMemoryCount,
      migratedAgents
    });

    const sentinelPath = join(tempDataDir, ".migration-v1-done");
    const agentsBeforeSecondRun = await fs.readFile(agentsStoreFile, "utf8");
    const sentinelBeforeSecondRun = await fs.readFile(sentinelPath, "utf8");

    const secondProfiles = deriveProfilesFromAgents(migratedAgents);
    const secondMigration = await migrateDataDirectory(
      {
        dataDir: tempDataDir,
        agentsStoreFile
      },
      migratedAgents as never,
      secondProfiles as never,
      logger
    );

    secondMigrationSkipped = !secondMigration.migrated;

    const agentsAfterSecondRun = await fs.readFile(agentsStoreFile, "utf8");
    const sentinelAfterSecondRun = await fs.readFile(sentinelPath, "utf8");

    addCheck(
      checks,
      "Second migration run skipped due sentinel",
      secondMigrationSkipped,
      `migrated=${secondMigration.migrated}`
    );

    addCheck(
      checks,
      "Idempotency: agents.json unchanged on second run",
      agentsBeforeSecondRun === agentsAfterSecondRun
    );

    addCheck(
      checks,
      "Idempotency: sentinel unchanged on second run",
      sentinelBeforeSecondRun === sentinelAfterSecondRun
    );
  } catch (error) {
    fatalError = errorToMessage(error);
  } finally {
    if (tempDataDir) {
      try {
        await fs.rm(tempDataDir, { recursive: true, force: true });
      } catch (cleanupError) {
        addCheck(checks, "Cleanup temp directory", false, errorToMessage(cleanupError));
      }
    }

    printSummary({
      sourceDataDir,
      tempDataDir,
      sourceSessionCount,
      sourceMemoryCount,
      dummySessionCount,
      firstMigrationRan,
      secondMigrationSkipped,
      checks,
      migrationLogs,
      fatalError,
      durationMs: Date.now() - startedAt
    });

    const hasFailures = checks.some((check) => !check.pass);
    if (fatalError || hasFailures) {
      process.exitCode = 1;
    }
  }
}

async function runPostMigrationChecks(input: {
  checks: CheckResult[];
  dataDir: string;
  sourceSessionCount: number;
  sourceMemoryCount: number;
  migratedAgents: AgentDescriptorLike[];
}): Promise<void> {
  const { checks, dataDir, sourceSessionCount, sourceMemoryCount, migratedAgents } = input;

  const featureManagerProfileDir = join(dataDir, "profiles", "feature-manager");
  const middlemanProjectProfileDir = join(dataDir, "profiles", "middleman-project");

  addCheck(
    checks,
    "Directory structure: profiles/feature-manager has memory, sessions, schedules, integrations",
    await allPathsExist([
      featureManagerProfileDir,
      join(featureManagerProfileDir, "memory.md"),
      join(featureManagerProfileDir, "sessions"),
      join(featureManagerProfileDir, "schedules"),
      join(featureManagerProfileDir, "integrations")
    ])
  );

  addCheck(
    checks,
    "Directory structure: profiles/middleman-project has memory, sessions, schedules, integrations",
    await allPathsExist([
      middlemanProjectProfileDir,
      join(middlemanProjectProfileDir, "memory.md"),
      join(middlemanProjectProfileDir, "sessions"),
      join(middlemanProjectProfileDir, "schedules"),
      join(middlemanProjectProfileDir, "integrations")
    ])
  );

  addCheck(
    checks,
    "Directory structure: shared/auth/auth.json exists",
    await pathExists(join(dataDir, "shared", "auth", "auth.json"))
  );

  addCheck(
    checks,
    "Directory structure: shared/integrations exists",
    await pathExists(join(dataDir, "shared", "integrations"))
  );

  const featureManagerRootMemory = join(dataDir, "profiles", "feature-manager", "memory.md");
  const featureManagerS2Memory = join(
    dataDir,
    "profiles",
    "feature-manager",
    "sessions",
    "feature-manager--s2",
    "memory.md"
  );

  addCheck(checks, "Memory: root session memory exists", await pathExists(featureManagerRootMemory));
  addCheck(checks, "Memory: non-root session memory exists", await pathExists(featureManagerS2Memory));

  const profileMarkdownFiles = await collectFiles(join(dataDir, "profiles"), (path) => path.endsWith(".md"));
  const workerMemoryCandidates = profileMarkdownFiles.filter(
    (path) => basename(path) !== "memory.md" || path.includes(`${sep}workers${sep}`)
  );

  addCheck(
    checks,
    "Memory: no worker memory files created",
    workerMemoryCandidates.length === 0,
    workerMemoryCandidates.length > 0
      ? `unexpected=${workerMemoryCandidates.slice(0, 10).join(", ")}`
      : undefined
  );

  const migratedMemoryCount = profileMarkdownFiles.filter((path) => basename(path) === "memory.md").length;
  const managerCount = migratedAgents.filter((agent) => agent.role === "manager").length;

  addCheck(
    checks,
    "Memory: migrated memory file count is far lower than flat layout",
    migratedMemoryCount < sourceMemoryCount && migratedMemoryCount <= managerCount,
    `flatMemory=${sourceMemoryCount}, migratedMemory=${migratedMemoryCount}, managers=${managerCount}`
  );

  addCheck(
    checks,
    "Sessions: root manager session file exists",
    await pathExists(
      join(dataDir, "profiles", "feature-manager", "sessions", "feature-manager", "session.jsonl")
    )
  );

  addCheck(
    checks,
    "Sessions: non-root manager session file exists",
    await pathExists(
      join(dataDir, "profiles", "feature-manager", "sessions", "feature-manager--s2", "session.jsonl")
    )
  );

  addCheck(
    checks,
    "Sessions: worker session file exists under owner session",
    await pathExists(
      join(
        dataDir,
        "profiles",
        "feature-manager",
        "sessions",
        "feature-manager--s2",
        "workers",
        "fireflies-review.jsonl"
      )
    )
  );

  const migratedSessionFiles = await collectFiles(join(dataDir, "profiles"), (path) => path.endsWith(".jsonl"));
  // Migration is descriptor-driven: only agents in agents.json get migrated.
  // Orphaned session files (no matching descriptor) are correctly skipped — cleanup deferred.
  addCheck(
    checks,
    "Sessions: migrated session file count matches agent count (orphans excluded)",
    migratedSessionFiles.length === migratedAgents.length,
    `agents=${migratedAgents.length}, migratedSessions=${migratedSessionFiles.length}, flatSessions=${sourceSessionCount} (${sourceSessionCount - migratedSessionFiles.length} orphaned)`
  );

  addCheck(
    checks,
    "Schedules: feature-manager schedule exists",
    await pathExists(join(dataDir, "profiles", "feature-manager", "schedules", "schedules.json"))
  );

  addCheck(
    checks,
    "Schedules: middleman-project schedule exists",
    await pathExists(join(dataDir, "profiles", "middleman-project", "schedules", "schedules.json"))
  );

  const managerDescriptors = migratedAgents.filter(
    (agent): agent is AgentDescriptorLike & { role: "manager" } => agent.role === "manager"
  );
  const workerDescriptors = migratedAgents.filter(
    (agent): agent is AgentDescriptorLike & { role: "worker" } => agent.role === "worker"
  );

  const managerProfileBySessionId = new Map<string, string>();
  const managerPathErrors: string[] = [];

  for (const manager of managerDescriptors) {
    const profileId = normalize(manager.profileId) ?? manager.agentId;
    managerProfileBySessionId.set(manager.agentId, profileId);

    const expectedPath = getSessionFilePath(dataDir, profileId, manager.agentId);
    if (manager.sessionFile !== expectedPath) {
      managerPathErrors.push(`${manager.agentId}: ${manager.sessionFile} != ${expectedPath}`);
    }
  }

  addCheck(
    checks,
    "agents.json rewrite: all manager sessionFile paths are hierarchical",
    managerPathErrors.length === 0,
    managerPathErrors.length > 0 ? managerPathErrors.slice(0, 10).join(" | ") : undefined
  );

  const workerPathErrors: string[] = [];
  for (const worker of workerDescriptors) {
    const profileId =
      normalize(worker.profileId) ?? managerProfileBySessionId.get(worker.managerId) ?? "default";

    const expectedPath = getWorkerSessionFilePath(dataDir, profileId, worker.managerId, worker.agentId);
    if (worker.sessionFile !== expectedPath) {
      workerPathErrors.push(`${worker.agentId}: ${worker.sessionFile} != ${expectedPath}`);
    }
  }

  addCheck(
    checks,
    "agents.json rewrite: all worker sessionFile paths are under workers/",
    workerPathErrors.length === 0,
    workerPathErrors.length > 0 ? workerPathErrors.slice(0, 10).join(" | ") : undefined
  );

  const legacySessionPrefix = `${join(dataDir, "sessions")}${sep}`;
  const legacySessionReferences = migratedAgents
    .map((agent) => agent.sessionFile)
    .filter((sessionFile): sessionFile is string => typeof sessionFile === "string")
    .filter((sessionFile) => sessionFile.startsWith(legacySessionPrefix));

  addCheck(
    checks,
    "agents.json rewrite: no legacy flat sessions/ references remain",
    legacySessionReferences.length === 0,
    legacySessionReferences.length > 0
      ? legacySessionReferences.slice(0, 10).join(", ")
      : undefined
  );

  const featureManagerMetaPath = join(
    dataDir,
    "profiles",
    "feature-manager",
    "sessions",
    "feature-manager",
    "meta.json"
  );
  addCheck(checks, "Meta: feature-manager root session meta.json exists", await pathExists(featureManagerMetaPath));

  const metaSamplePaths = [
    featureManagerMetaPath,
    join(dataDir, "profiles", "feature-manager", "sessions", "feature-manager--s2", "meta.json"),
    join(dataDir, "profiles", "middleman-project", "sessions", "middleman-project", "meta.json")
  ];

  const metaErrors: string[] = [];
  for (const metaPath of metaSamplePaths) {
    if (!(await pathExists(metaPath))) {
      metaErrors.push(`missing:${metaPath}`);
      continue;
    }

    try {
      const parsed = (await readJson(metaPath)) as Record<string, unknown>;
      const hasShape =
        typeof parsed.sessionId === "string" &&
        parsed.sessionId.length > 0 &&
        typeof parsed.profileId === "string" &&
        parsed.profileId.length > 0 &&
        typeof parsed.createdAt === "string" &&
        parsed.createdAt.length > 0 &&
        typeof parsed.stats === "object" &&
        parsed.stats !== null &&
        Array.isArray(parsed.workers);

      if (!hasShape) {
        metaErrors.push(`invalid:${metaPath}`);
      }
    } catch (error) {
      metaErrors.push(`parseError:${metaPath}:${errorToMessage(error)}`);
    }
  }

  addCheck(
    checks,
    "Meta: sampled meta.json files contain sessionId/profileId/createdAt/stats/workers",
    metaErrors.length === 0,
    metaErrors.length > 0 ? metaErrors.join(" | ") : undefined
  );

  addCheck(
    checks,
    "Sentinel: .migration-v1-done exists",
    await pathExists(join(dataDir, ".migration-v1-done"))
  );
}

async function createWorkingCopy(sourceDataDir: string, targetDataDir: string): Promise<WorkingCopyStats> {
  await fs.mkdir(targetDataDir, { recursive: true });

  const sourceAgentsFile = join(sourceDataDir, "swarm", "agents.json");
  const targetAgentsFile = join(targetDataDir, "swarm", "agents.json");
  await fs.mkdir(join(targetDataDir, "swarm"), { recursive: true });
  await fs.copyFile(sourceAgentsFile, targetAgentsFile);

  await copyDirectoryIfExists(join(sourceDataDir, "memory"), join(targetDataDir, "memory"));
  await copyDirectoryIfExists(join(sourceDataDir, "schedules"), join(targetDataDir, "schedules"));
  await copyDirectoryIfExists(join(sourceDataDir, "auth"), join(targetDataDir, "auth"));
  await copyDirectoryIfExists(join(sourceDataDir, "integrations"), join(targetDataDir, "integrations"));
  await copyFileIfExists(join(sourceDataDir, "secrets.json"), join(targetDataDir, "secrets.json"));

  const sourceSessionsDir = join(sourceDataDir, "sessions");
  const targetSessionsDir = join(targetDataDir, "sessions");
  await fs.mkdir(targetSessionsDir, { recursive: true });

  const sessionEntries = await fs.readdir(sourceSessionsDir, { withFileTypes: true });
  let sourceSessionCount = 0;
  let dummySessionCount = 0;

  for (const entry of sessionEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    sourceSessionCount += 1;
    await fs.writeFile(join(targetSessionsDir, entry.name), "x", "utf8");
    dummySessionCount += 1;
  }

  const sourceMemoryCount = await countFiles(join(sourceDataDir, "memory"), (path) => path.endsWith(".md"));

  return {
    sourceSessionCount,
    sourceMemoryCount,
    dummySessionCount
  };
}

function deriveProfilesFromAgents(agents: AgentDescriptorLike[]): ManagerProfileLike[] {
  const managers = agents
    .filter((agent): agent is AgentDescriptorLike & { role: "manager" } => agent.role === "manager")
    .map((manager) => ({
      ...manager,
      profileId: normalize(manager.profileId) ?? manager.agentId
    }));

  const grouped = new Map<string, Array<AgentDescriptorLike & { role: "manager"; profileId: string }>>();
  for (const manager of managers) {
    const group = grouped.get(manager.profileId) ?? [];
    group.push(manager);
    grouped.set(manager.profileId, group);
  }

  const profiles: ManagerProfileLike[] = [];

  for (const [profileId, group] of grouped.entries()) {
    group.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.agentId.localeCompare(right.agentId);
    });

    const rootSession = group.find((manager) => manager.agentId === profileId) ?? group[0];
    const createdAt = group.map((manager) => manager.createdAt).sort()[0] ?? rootSession.createdAt;
    const updatedAt = group.map((manager) => manager.updatedAt).sort().at(-1) ?? rootSession.updatedAt;

    profiles.push({
      profileId,
      displayName: normalize(rootSession.displayName) ?? profileId,
      defaultSessionAgentId: rootSession.agentId,
      createdAt,
      updatedAt
    });
  }

  profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
  return profiles;
}

async function allPathsExist(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (!(await pathExists(path))) {
      return false;
    }
  }
  return true;
}

async function copyDirectoryIfExists(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await pathExists(sourceDir))) {
    return;
  }
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function copyFileIfExists(sourceFile: string, targetFile: string): Promise<void> {
  if (!(await pathExists(sourceFile))) {
    return;
  }

  await fs.mkdir(dirname(targetFile), { recursive: true });
  await fs.copyFile(sourceFile, targetFile);
}

async function collectFiles(rootDir: string, predicate?: (path: string) => boolean): Promise<string[]> {
  if (!(await pathExists(rootDir))) {
    return [];
  }

  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        if (!predicate || predicate(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  }

  files.sort();
  return files;
}

async function countFiles(rootDir: string, predicate?: (path: string) => boolean): Promise<number> {
  const files = await collectFiles(rootDir, predicate);
  return files.length;
}

async function readJson(path: string): Promise<unknown> {
  const raw = await fs.readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }
    throw error;
  }
}

function addCheck(checks: CheckResult[], name: string, pass: boolean, details?: string): void {
  checks.push({ name, pass, details });
}

function printSummary(input: {
  sourceDataDir: string;
  tempDataDir: string | null;
  sourceSessionCount: number;
  sourceMemoryCount: number;
  dummySessionCount: number;
  firstMigrationRan: boolean;
  secondMigrationSkipped: boolean;
  checks: CheckResult[];
  migrationLogs: CapturedLog[];
  fatalError: string | null;
  durationMs: number;
}): void {
  const {
    sourceDataDir,
    tempDataDir,
    sourceSessionCount,
    sourceMemoryCount,
    dummySessionCount,
    firstMigrationRan,
    secondMigrationSkipped,
    checks,
    migrationLogs,
    fatalError,
    durationMs
  } = input;

  const passed = checks.filter((check) => check.pass).length;
  const failed = checks.length - passed;

  console.log("\n=== Migration Validation Summary ===");
  console.log(`Source data dir: ${sourceDataDir}`);
  console.log(`Temp data dir: ${tempDataDir ?? "(not created)"}`);
  console.log(
    `Working copy stats: sourceSessions=${sourceSessionCount}, sourceMemoryFiles=${sourceMemoryCount}, dummySessions=${dummySessionCount}`
  );
  console.log(
    `Migration runs: firstRan=${firstMigrationRan}, secondSkippedBySentinel=${secondMigrationSkipped}, logsCaptured=${migrationLogs.length}`
  );

  if (migrationLogs.length > 0) {
    const warnCount = migrationLogs.filter((log) => log.level === "warn").length;
    console.log(`Migration log warnings: ${warnCount}`);
  }

  console.log("\nChecks:");
  for (const check of checks) {
    const status = check.pass ? "PASS" : "FAIL";
    if (check.details) {
      console.log(`- [${status}] ${check.name} :: ${check.details}`);
    } else {
      console.log(`- [${status}] ${check.name}`);
    }
  }

  if (fatalError) {
    console.log(`\nFatal error: ${fatalError}`);
  }

  console.log(`\nResult: ${failed === 0 && !fatalError ? "PASS" : "FAIL"} (${passed}/${checks.length} checks passed)`);
  console.log(`Duration: ${durationMs}ms`);
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();

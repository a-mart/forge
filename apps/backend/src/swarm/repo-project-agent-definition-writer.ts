import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import type {
  ProjectAgentCapability,
  RepoProjectAgentDefinitionConfig,
} from "@forge/protocol";
import { writeFileAtomic, writeJsonFileAtomic } from "../utils/atomic-files.js";
import { isEnoentError, isErrnoCode } from "../utils/fs-errors.js";
import {
  isReservedProjectAgentHandle,
  normalizeProjectAgentHandle,
} from "./agents/project-agent-registry.js";
import { normalizeProjectAgentInlineText } from "./agents/project-agents.js";
import { getProjectForgeProjectAgentsDir, sanitizePathSegment } from "./data-paths.js";
import {
  scanRepoProjectAgentDefinitions,
  type ParsedRepoProjectAgentDefinition,
} from "./repo-project-agent-definitions.js";

const MAX_WHEN_TO_USE_LENGTH = 280;
const DEFINITION_LOCK_TIMEOUT_MS = 10_000;
const DEFINITION_LOCK_RETRY_MS = 10;

export interface WriteRepoProjectAgentDefinitionInput {
  forgeDir: string;
  /** When set, the effective .forge realpath must remain under this repository root. */
  containmentRoot?: string;
  handle: string;
  displayName?: string;
  whenToUse: string;
  capabilities?: ProjectAgentCapability[];
  prompt: string;
}

export interface WrittenRepoProjectAgentDefinition {
  definition: ParsedRepoProjectAgentDefinition;
  definitionId: string;
  forgeDir: string;
  projectAgentsDir: string;
  definitionDir: string;
  createdForgeDir: boolean;
  createdProjectAgentsDir: boolean;
}

interface PlacementParents {
  forgeDir: string;
  forgeDirRealpath: string;
  projectAgentsDir: string;
  projectAgentsDirRealpath: string;
  createdForgeDir: boolean;
  createdProjectAgentsDir: boolean;
}

export async function writeRepoProjectAgentDefinition(
  input: WriteRepoProjectAgentDefinitionInput,
): Promise<WrittenRepoProjectAgentDefinition> {
  const handle = normalizeProjectAgentHandle(input.handle);
  if (!handle) {
    throw new Error("Project agent handle must contain at least one letter, number, or dash");
  }
  if (isReservedProjectAgentHandle(handle)) {
    throw new Error(`Project agent handle "${handle}" is reserved.`);
  }

  const whenToUse = normalizeProjectAgentInlineText(input.whenToUse);
  if (!whenToUse) {
    throw new Error("Repository Project Agent whenToUse must be non-empty");
  }
  if (whenToUse.length > MAX_WHEN_TO_USE_LENGTH) {
    throw new Error(`Repository Project Agent whenToUse must be ${MAX_WHEN_TO_USE_LENGTH} characters or fewer`);
  }

  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Repository Project Agent placement requires non-empty role instructions for prompt.md.");
  }

  const displayName = input.displayName?.trim();
  const capabilities = Array.from(
    new Set((input.capabilities ?? []).filter((capability) => capability === "create_session")),
  );
  const definitionId = sanitizePathSegment(handle);
  const config: RepoProjectAgentDefinitionConfig = {
    version: 1,
    handle,
    whenToUse,
    ...(displayName ? { displayName } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };

  const parents = await ensurePlacementParents(input.forgeDir, input.containmentRoot);
  const definitionDir = join(parents.projectAgentsDir, definitionId);
  const lockPath = join(parents.forgeDir, `.project-agent-${definitionId}.lock`);
  let lockAcquired = false;
  let stagingRoot: string | undefined;
  let published = false;
  let completed = false;

  try {
    await acquireDefinitionLock(lockPath, definitionId);
    lockAcquired = true;
    await preflightDefinitionTarget(parents.projectAgentsDir, definitionDir, definitionId, handle);

    stagingRoot = join(parents.forgeDir, `.project-agent-staging-${definitionId}-${randomUUID()}`);
    const stagedDefinitionDir = join(stagingRoot, definitionId);
    await mkdir(stagedDefinitionDir, { recursive: true });
    await assertRealDirectory(stagingRoot, "Repository Project Agent staging root");
    await assertRealDirectory(stagedDefinitionDir, "Repository Project Agent staging definition");
    await assertContainedRealpath(stagingRoot, parents.forgeDirRealpath, "Repository Project Agent staging root");

    await writeFileAtomic(join(stagedDefinitionDir, "prompt.md"), `${prompt}\n`);
    await writeJsonFileAtomic(join(stagedDefinitionDir, "config.json"), config);

    const stagedInventory = await scanRepoProjectAgentDefinitions(stagingRoot);
    const stagedDefinition = stagedInventory.definitions.find(
      (candidate) => candidate.definitionId === definitionId,
    );
    const stagedItem = stagedInventory.items.find(
      (candidate) => candidate.definitionId === definitionId,
    );
    if (!stagedDefinition || stagedItem?.status !== "valid") {
      const details = stagedItem?.problems.map((problem) => problem.message).join("; ");
      throw new Error(
        `Staged repository Project Agent definition ${definitionId} is not valid${details ? `: ${details}` : "."}`,
      );
    }

    // The lock serializes Forge writers. Repeat the target and duplicate-handle
    // check immediately before the single atomic visibility boundary.
    await preflightDefinitionTarget(parents.projectAgentsDir, definitionDir, definitionId, handle);
    try {
      // Atomic directory publication has no writeFileAtomic equivalent.
      // eslint-disable-next-line no-restricted-syntax
      await rename(stagedDefinitionDir, definitionDir);
    } catch (error) {
      if (isErrnoCode(error, "EEXIST") || isErrnoCode(error, "ENOTEMPTY")) {
        throw existingDefinitionError(definitionId);
      }
      throw error;
    }
    published = true;

    await assertRealDirectory(definitionDir, "Repository Project Agent definition");
    await assertContainedRealpath(
      definitionDir,
      parents.projectAgentsDirRealpath,
      "Repository Project Agent definition",
    );

    const written = {
      definition: { ...stagedDefinition, dirPath: definitionDir },
      definitionId,
      forgeDir: parents.forgeDirRealpath,
      projectAgentsDir: parents.projectAgentsDirRealpath,
      definitionDir: await realpath(definitionDir),
      createdForgeDir: parents.createdForgeDir,
      createdProjectAgentsDir: parents.createdProjectAgentsDir,
    };
    completed = true;
    return written;
  } catch (error) {
    if (published) {
      await removeRepoProjectAgentDefinitionDir(definitionDir).catch(() => undefined);
    }
    throw error;
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (lockAcquired) {
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
    if (!completed) {
      await cleanupEmptyCreatedParents(parents).catch(() => undefined);
    }
  }
}

export async function rollbackWrittenRepoProjectAgentDefinition(
  written: WrittenRepoProjectAgentDefinition,
): Promise<void> {
  await removeRepoProjectAgentDefinitionDir(written.definitionDir);
  await cleanupEmptyCreatedParents({
    forgeDir: written.forgeDir,
    forgeDirRealpath: written.forgeDir,
    projectAgentsDir: written.projectAgentsDir,
    projectAgentsDirRealpath: written.projectAgentsDir,
    createdForgeDir: written.createdForgeDir,
    createdProjectAgentsDir: written.createdProjectAgentsDir,
  });
}

export async function removeRepoProjectAgentDefinitionDir(definitionDir: string): Promise<void> {
  await rm(definitionDir, { recursive: true, force: true });
}

async function ensurePlacementParents(
  forgeDirValue: string,
  containmentRootValue?: string,
): Promise<PlacementParents> {
  const forgeDir = resolve(forgeDirValue);
  if (basename(forgeDir) !== ".forge") {
    throw new Error("Repository Project Agent placement must write under a directory named .forge.");
  }

  const state: PlacementParents = {
    forgeDir,
    forgeDirRealpath: forgeDir,
    projectAgentsDir: getProjectForgeProjectAgentsDir(forgeDir),
    projectAgentsDirRealpath: getProjectForgeProjectAgentsDir(forgeDir),
    createdForgeDir: false,
    createdProjectAgentsDir: false,
  };

  try {
    const repositoryRootRealpath = containmentRootValue
      ? await realpath(resolve(containmentRootValue))
      : undefined;
    if (repositoryRootRealpath) {
      await assertRealDirectory(repositoryRootRealpath, "Repository root");
    } else {
      await assertRealDirectory(dirname(forgeDir), "Repository root");
    }

    state.createdForgeDir = await ensureRealDirectory(forgeDir, "The effective .forge directory");
    state.forgeDirRealpath = await realpath(forgeDir);
    if (repositoryRootRealpath && !isPathInside(state.forgeDirRealpath, repositoryRootRealpath)) {
      throw new Error("The effective .forge directory resolves outside the detected Git repository root.");
    }

    state.createdProjectAgentsDir = await ensureRealDirectory(
      state.projectAgentsDir,
      "The repository project-agents directory",
    );
    state.projectAgentsDirRealpath = await realpath(state.projectAgentsDir);
    if (!isPathInside(state.projectAgentsDirRealpath, state.forgeDirRealpath)) {
      throw new Error("The repository project-agents directory resolves outside the effective .forge directory.");
    }
    return state;
  } catch (error) {
    await cleanupEmptyCreatedParents(state).catch(() => undefined);
    throw error;
  }
}

async function ensureRealDirectory(pathValue: string, label: string): Promise<boolean> {
  let created = false;
  const existing = await lstat(pathValue).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!existing) {
    try {
      await mkdir(pathValue, { recursive: false });
      created = true;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
    }
  }

  // Re-check after mkdir/EEXIST so a concurrent replacement cannot turn a
  // newly created parent into a followed symlink.
  await assertRealDirectory(pathValue, label);
  await realpath(pathValue);
  return created;
}

async function acquireDefinitionLock(lockPath: string, definitionId: string): Promise<void> {
  const deadline = Date.now() + DEFINITION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.close();
      return;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting to write repository Project Agent definition ${definitionId}. Another Forge writer still holds its lock.`,
        );
      }
      await delay(DEFINITION_LOCK_RETRY_MS);
    }
  }
}

async function preflightDefinitionTarget(
  projectAgentsDir: string,
  definitionDir: string,
  definitionId: string,
  handle: string,
): Promise<void> {
  const target = await lstat(definitionDir).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (target) {
    throw existingDefinitionError(definitionId);
  }

  const inventory = await scanRepoProjectAgentDefinitions(projectAgentsDir);
  if (inventory.problems?.length) {
    throw new Error(
      `Cannot inspect existing repository Project Agent definitions: ${inventory.problems.map((problem) => problem.message).join("; ")}`,
    );
  }
  if (inventory.truncated) {
    throw new Error(
      "Cannot safely check for duplicate repository Project Agent handles because the definition inventory is truncated.",
    );
  }
  const duplicate = inventory.items.find(
    (candidate) => normalizeProjectAgentHandle(candidate.handle) === handle,
  );
  if (duplicate) {
    throw new Error(
      `Repository Project Agent handle "${handle}" already exists in .forge/project-agents/${duplicate.definitionId}. Choose a different handle or edit the existing definition files.`,
    );
  }
}

function existingDefinitionError(definitionId: string): Error {
  return new Error(
    `A repository Project Agent definition already exists at .forge/project-agents/${definitionId}. Choose a different handle or edit the existing definition files.`,
  );
}

async function assertRealDirectory(pathValue: string, label: string): Promise<void> {
  const existing = await lstat(pathValue).catch((error: unknown) => {
    if (isEnoentError(error)) {
      throw new Error(`${label} does not exist: ${pathValue}`);
    }
    throw error;
  });
  if (existing.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${pathValue}`);
  }
  if (!existing.isDirectory()) {
    throw new Error(`${label} is not a directory: ${pathValue}`);
  }
}

async function assertContainedRealpath(
  pathValue: string,
  rootRealpath: string,
  label: string,
): Promise<void> {
  const pathRealpath = await realpath(pathValue);
  if (!isPathInside(pathRealpath, rootRealpath)) {
    throw new Error(`${label} resolves outside its expected parent.`);
  }
}

async function cleanupEmptyCreatedParents(parents: PlacementParents): Promise<void> {
  if (parents.createdProjectAgentsDir) {
    await removeEmptyDirectory(parents.projectAgentsDir);
  }
  if (parents.createdForgeDir) {
    await removeEmptyDirectory(parents.forgeDir);
  }
}

async function removeEmptyDirectory(pathValue: string): Promise<void> {
  try {
    await rmdir(pathValue);
  } catch (error) {
    if (
      isEnoentError(error) ||
      isErrnoCode(error, "ENOTEMPTY") ||
      isErrnoCode(error, "EEXIST")
    ) {
      return;
    }
    throw error;
  }
}

function isPathInside(pathValue: string, rootPath: string): boolean {
  const normalizedPath = normalizeComparablePath(pathValue);
  const normalizedRoot = normalizeComparablePath(rootPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function normalizeComparablePath(pathValue: string): string {
  const normalized = normalize(resolve(pathValue));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

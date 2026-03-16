import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CortexPromptSurfaceContentResponse,
  CortexPromptSurfaceListEntry,
  CortexPromptSurfaceListResponse,
  PromptCategory,
  ServerEvent,
} from "@middleman/protocol";
import {
  getCommonKnowledgePath,
  getCortexNotesPath,
  getCortexWorkerPromptsPath,
} from "./data-paths.js";
import type { PromptRegistryForRoutes } from "../ws/routes/prompt-routes.js";

const CORTEX_PROFILE_ID = "cortex";

interface CortexPromptSurfaceDefinition {
  surfaceId: string;
  title: string;
  description: string;
  group: CortexPromptSurfaceListEntry["group"];
  kind: CortexPromptSurfaceListEntry["kind"];
  editable: boolean;
  resetMode: CortexPromptSurfaceListEntry["resetMode"];
  runtimeEffect: CortexPromptSurfaceListEntry["runtimeEffect"];
  warning?: string;
  category?: PromptCategory;
  promptId?: string;
  seedPrompt?: CortexPromptSurfaceListEntry["seedPrompt"];
  resolveFilePath?: (dataDir: string) => string;
}

const CORTEX_PROMPT_SURFACES: readonly CortexPromptSurfaceDefinition[] = [
  {
    surfaceId: "cortex-system-prompt",
    title: "Cortex System Prompt",
    description: "Core instructions for the Cortex intelligence and knowledge manager.",
    group: "system",
    kind: "registry",
    editable: true,
    resetMode: "profileOverride",
    runtimeEffect: "liveImmediate",
    category: "archetype",
    promptId: "cortex",
  },
  {
    surfaceId: "common-knowledge-template",
    title: "Common Knowledge Template",
    description: "Boot seed template for shared/knowledge/common.md.",
    group: "seed",
    kind: "registry",
    editable: true,
    resetMode: "profileOverride",
    runtimeEffect: "futureSeedOnly",
    warning: "Boot seed only — changing this does not rewrite an existing shared/knowledge/common.md live file.",
    category: "operational",
    promptId: "common-knowledge-template",
  },
  {
    surfaceId: "common-knowledge-live",
    title: "Common Knowledge",
    description: "Live injected shared knowledge used in Cortex memory injection.",
    group: "live",
    kind: "file",
    editable: true,
    resetMode: "none",
    runtimeEffect: "liveInjected",
    warning: "Live injected context — edits affect the current shared/knowledge/common.md used across agents.",
    seedPrompt: { category: "operational", promptId: "common-knowledge-template" },
    resolveFilePath: getCommonKnowledgePath,
  },
  {
    surfaceId: "cortex-worker-prompts-template",
    title: "Cortex Worker Prompt Templates",
    description: "Boot seed template for the live Cortex worker prompt file.",
    group: "seed",
    kind: "registry",
    editable: true,
    resetMode: "profileOverride",
    runtimeEffect: "futureSeedOnly",
    warning:
      "Boot seed only — changing this does not rewrite an existing shared/knowledge/.cortex-worker-prompts.md live file.",
    category: "operational",
    promptId: "cortex-worker-prompts",
  },
  {
    surfaceId: "cortex-worker-prompts-live",
    title: "Cortex Worker Prompt Templates (Live File)",
    description: "Live Cortex worker prompt file read when Cortex delegates review and synthesis work.",
    group: "live",
    kind: "file",
    editable: true,
    resetMode: "reseedFromTemplate",
    runtimeEffect: "liveImmediate",
    warning: "Live Cortex file — Cortex reads this file when spawning workers.",
    seedPrompt: { category: "operational", promptId: "cortex-worker-prompts" },
    resolveFilePath: getCortexWorkerPromptsPath,
  },
  {
    surfaceId: "cortex-notes",
    title: "Cortex Notes",
    description: "Scratch notes file for tentative Cortex observations.",
    group: "scratch",
    kind: "file",
    editable: false,
    resetMode: "none",
    runtimeEffect: "scratchOnly",
    warning: "Scratch only — referenced by Cortex for tentative notes; not injected into the manager system prompt.",
    resolveFilePath: getCortexNotesPath,
  },
];

function isCortexProfile(profileId: string | undefined): boolean {
  return profileId?.trim() === CORTEX_PROFILE_ID;
}

function getSurfaceDefinition(surfaceId: string): CortexPromptSurfaceDefinition | undefined {
  return CORTEX_PROMPT_SURFACES.find((surface) => surface.surfaceId === surfaceId);
}

function normalizeTrackedPath(filePath: string): string {
  return resolve(filePath);
}

async function readOptionalFileContent(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return "";
    }
    throw error;
  }
}

async function getOptionalLastModifiedAt(filePath: string): Promise<string | undefined> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function buildSurfaceListEntry(
  definition: CortexPromptSurfaceDefinition,
  options: {
    dataDir: string;
    profileId: string;
    promptRegistry: PromptRegistryForRoutes;
  },
): Promise<CortexPromptSurfaceListEntry> {
  if (definition.kind === "registry") {
    const { category, promptId } = definition;
    if (!category || !promptId) {
      throw new Error(`Registry-backed Cortex surface is missing prompt metadata: ${definition.surfaceId}`);
    }

    const entry = await options.promptRegistry.resolveEntry(category, promptId, options.profileId);
    return {
      surfaceId: definition.surfaceId,
      title: definition.title,
      description: definition.description,
      group: definition.group,
      kind: definition.kind,
      editable: definition.editable,
      resetMode: definition.resetMode,
      runtimeEffect: definition.runtimeEffect,
      warning: definition.warning,
      category,
      promptId,
      activeLayer: entry?.sourceLayer ?? "builtin",
      sourcePath: entry?.sourcePath ?? "",
      seedPrompt: definition.seedPrompt ?? null,
    };
  }

  const filePath = definition.resolveFilePath?.(options.dataDir);
  if (!filePath) {
    throw new Error(`File-backed Cortex surface is missing a file path resolver: ${definition.surfaceId}`);
  }

  return {
    surfaceId: definition.surfaceId,
    title: definition.title,
    description: definition.description,
    group: definition.group,
    kind: definition.kind,
    editable: definition.editable,
    resetMode: definition.resetMode,
    runtimeEffect: definition.runtimeEffect,
    warning: definition.warning,
    filePath,
    sourcePath: filePath,
    lastModifiedAt: await getOptionalLastModifiedAt(filePath),
    seedPrompt: definition.seedPrompt ?? null,
  };
}

export async function listCortexPromptSurfaces(options: {
  dataDir: string;
  profileId: string;
  promptRegistry: PromptRegistryForRoutes;
}): Promise<CortexPromptSurfaceListResponse> {
  if (!isCortexProfile(options.profileId)) {
    return {
      enabled: false,
      surfaces: [],
    };
  }

  const surfaces = await Promise.all(
    CORTEX_PROMPT_SURFACES.map((surface) => buildSurfaceListEntry(surface, options)),
  );

  return {
    enabled: true,
    surfaces,
  };
}

export async function readCortexPromptSurface(options: {
  dataDir: string;
  profileId: string;
  surfaceId: string;
  promptRegistry: PromptRegistryForRoutes;
}): Promise<CortexPromptSurfaceContentResponse> {
  if (!isCortexProfile(options.profileId)) {
    throw new Error("Cortex prompt surfaces are only available for the cortex profile.");
  }

  const definition = getSurfaceDefinition(options.surfaceId);
  if (!definition) {
    throw new Error(`Unknown Cortex prompt surface '${options.surfaceId}'.`);
  }

  const base = await buildSurfaceListEntry(definition, options);

  if (definition.kind === "registry") {
    const { category, promptId } = definition;
    if (!category || !promptId) {
      throw new Error(`Registry-backed Cortex surface is missing prompt metadata: ${definition.surfaceId}`);
    }

    const entry = await options.promptRegistry.resolveEntry(category, promptId, options.profileId);
    if (!entry) {
      throw new Error(`Prompt '${category}/${promptId}' not found.`);
    }

    return {
      ...base,
      content: entry.content,
    };
  }

  const filePath = definition.resolveFilePath?.(options.dataDir);
  if (!filePath) {
    throw new Error(`File-backed Cortex surface is missing a file path resolver: ${definition.surfaceId}`);
  }

  return {
    ...base,
    content: await readOptionalFileContent(filePath),
  };
}

export function getTrackedCortexPromptSurfaceByPath(
  dataDir: string,
  filePath: string,
): { surfaceId: string; filePath: string } | undefined {
  const normalizedFilePath = normalizeTrackedPath(filePath);

  for (const surface of CORTEX_PROMPT_SURFACES) {
    if (surface.kind !== "file" || !surface.resolveFilePath) {
      continue;
    }

    const candidatePath = surface.resolveFilePath(dataDir);
    if (normalizeTrackedPath(candidatePath) !== normalizedFilePath) {
      continue;
    }

    return {
      surfaceId: surface.surfaceId,
      filePath: candidatePath,
    };
  }

  return undefined;
}

export async function writeTrackedCortexPromptSurfaceFile(options: {
  dataDir: string;
  filePath: string;
  content: string;
  broadcastEvent?: (event: ServerEvent) => void;
}): Promise<{ surfaceId: string; filePath: string; lastModifiedAt: string; bytesWritten: number }> {
  const trackedSurface = getTrackedCortexPromptSurfaceByPath(options.dataDir, options.filePath);
  if (!trackedSurface) {
    throw new Error(`Path '${options.filePath}' is not a tracked Cortex prompt surface.`);
  }

  await mkdir(dirname(trackedSurface.filePath), { recursive: true });
  await writeFile(trackedSurface.filePath, options.content, "utf8");
  const lastModifiedAt = (await stat(trackedSurface.filePath)).mtime.toISOString();

  options.broadcastEvent?.({
    type: "cortex_prompt_surface_changed",
    profileId: CORTEX_PROFILE_ID,
    surfaceId: trackedSurface.surfaceId,
    filePath: trackedSurface.filePath,
    updatedAt: lastModifiedAt,
  });

  return {
    surfaceId: trackedSurface.surfaceId,
    filePath: trackedSurface.filePath,
    lastModifiedAt,
    bytesWritten: Buffer.byteLength(options.content, "utf8"),
  };
}

export async function saveCortexPromptSurface(options: {
  dataDir: string;
  profileId: string;
  surfaceId: string;
  content: string;
  promptRegistry: PromptRegistryForRoutes;
  broadcastEvent?: (event: ServerEvent) => void;
}): Promise<void> {
  if (!isCortexProfile(options.profileId)) {
    throw new Error("Cortex prompt surfaces are only available for the cortex profile.");
  }

  const definition = getSurfaceDefinition(options.surfaceId);
  if (!definition) {
    throw new Error(`Unknown Cortex prompt surface '${options.surfaceId}'.`);
  }

  if (!definition.editable) {
    throw new Error(`Cortex prompt surface '${options.surfaceId}' is read-only.`);
  }

  if (definition.kind === "registry") {
    const { category, promptId } = definition;
    if (!category || !promptId) {
      throw new Error(`Registry-backed Cortex surface is missing prompt metadata: ${definition.surfaceId}`);
    }

    await options.promptRegistry.save(category, promptId, options.content, options.profileId);
    options.broadcastEvent?.({
      type: "prompt_changed",
      category,
      promptId,
      layer: "profile",
      action: "saved",
    });
    return;
  }

  const filePath = definition.resolveFilePath?.(options.dataDir);
  if (!filePath) {
    throw new Error(`File-backed Cortex surface is missing a file path resolver: ${definition.surfaceId}`);
  }

  await writeTrackedCortexPromptSurfaceFile({
    dataDir: options.dataDir,
    filePath,
    content: options.content,
    broadcastEvent: options.broadcastEvent,
  });
}

export async function resetCortexPromptSurface(options: {
  dataDir: string;
  profileId: string;
  surfaceId: string;
  promptRegistry: PromptRegistryForRoutes;
  broadcastEvent?: (event: ServerEvent) => void;
}): Promise<void> {
  if (!isCortexProfile(options.profileId)) {
    throw new Error("Cortex prompt surfaces are only available for the cortex profile.");
  }

  const definition = getSurfaceDefinition(options.surfaceId);
  if (!definition) {
    throw new Error(`Unknown Cortex prompt surface '${options.surfaceId}'.`);
  }

  if (definition.resetMode === "none") {
    throw new Error(`Cortex prompt surface '${options.surfaceId}' does not support reset.`);
  }

  if (definition.kind === "registry") {
    const { category, promptId } = definition;
    if (!category || !promptId) {
      throw new Error(`Registry-backed Cortex surface is missing prompt metadata: ${definition.surfaceId}`);
    }

    const hasOverride = await options.promptRegistry.hasOverride(category, promptId, options.profileId);
    if (!hasOverride) {
      throw new Error(`No profile override exists for ${category}/${promptId}.`);
    }

    await options.promptRegistry.deleteOverride(category, promptId, options.profileId);
    options.broadcastEvent?.({
      type: "prompt_changed",
      category,
      promptId,
      layer: "profile",
      action: "deleted",
    });
    return;
  }

  if (definition.surfaceId !== "cortex-worker-prompts-live") {
    throw new Error(`Unsupported Cortex prompt surface reset mode for '${options.surfaceId}'.`);
  }

  const templateContent = await options.promptRegistry.resolve(
    "operational",
    "cortex-worker-prompts",
    options.profileId,
  );
  const filePath = definition.resolveFilePath?.(options.dataDir);
  if (!filePath) {
    throw new Error(`File-backed Cortex surface is missing a file path resolver: ${definition.surfaceId}`);
  }

  await writeTrackedCortexPromptSurfaceFile({
    dataDir: options.dataDir,
    filePath,
    content: templateContent,
    broadcastEvent: options.broadcastEvent,
  });
}

function isEnoentError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

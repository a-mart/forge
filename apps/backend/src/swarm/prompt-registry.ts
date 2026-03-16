import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import { sanitizePathSegment } from "./data-paths.js";

const PROMPT_REGISTRY_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_PACKAGE_DIR = join(PROMPT_REGISTRY_DIR, "..", "..");

export type PromptCategory = "archetype" | "operational";

export type PromptSourceLayer = "profile" | "repo" | "builtin";

export interface PromptEntry {
  category: PromptCategory;
  promptId: string;
  content: string;
  sourceLayer: PromptSourceLayer;
  sourcePath: string;
}

export interface PromptRegistryOptions {
  dataDir: string;
  repoDir: string;
  builtinArchetypesDir: string;
  builtinOperationalDir: string;
  versioning?: VersioningMutationSink;
}

export interface PromptRegistry {
  resolve(category: PromptCategory, promptId: string, profileId?: string): Promise<string>;
  resolveEntry(category: PromptCategory, promptId: string, profileId?: string): Promise<PromptEntry | undefined>;
  resolveAtLayer(
    category: PromptCategory,
    promptId: string,
    layer: PromptSourceLayer,
    profileId?: string
  ): Promise<string | undefined>;
  listAll(profileId?: string): Promise<PromptEntry[]>;
  save(category: PromptCategory, promptId: string, content: string, profileId: string): Promise<void>;
  deleteOverride(category: PromptCategory, promptId: string, profileId: string): Promise<void>;
  hasOverride(category: PromptCategory, promptId: string, profileId: string): Promise<boolean>;
  invalidate(category?: PromptCategory, promptId?: string): void;
}

export interface PromptResolver {
  readonly layer: PromptSourceLayer;

  resolve(
    category: PromptCategory,
    promptId: string,
    profileId?: string
  ): Promise<PromptEntry | undefined>;

  listPromptIds(category: PromptCategory, profileId?: string): Promise<string[]>;
}

export class FileBackedPromptRegistry implements PromptRegistry {
  private readonly cache = new Map<string, PromptEntry | null>();
  private readonly resolvers: PromptResolver[];

  constructor(private readonly options: PromptRegistryOptions) {
    this.resolvers = [
      new ProfilePromptResolver(options.dataDir),
      new RepoPromptResolver(options.repoDir),
      new BuiltinPromptResolver(options)
    ];
  }

  async resolve(category: PromptCategory, promptId: string, profileId?: string): Promise<string> {
    const entry = await this.resolveEntry(category, promptId, profileId);
    if (!entry) {
      throw new Error(`Prompt not found: ${category}/${promptId}`);
    }

    return entry.content;
  }

  async resolveEntry(
    category: PromptCategory,
    promptId: string,
    profileId?: string
  ): Promise<PromptEntry | undefined> {
    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const cacheKey = this.buildCacheKey(category, normalizedPromptId, profileId);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? undefined;
    }

    for (const resolver of this.resolvers) {
      try {
        const entry = await resolver.resolve(category, normalizedPromptId, profileId);
        if (entry) {
          this.cache.set(cacheKey, entry);
          return entry;
        }
      } catch (error) {
        if (resolver.layer !== "builtin") {
          console.warn(
            `[swarm] Prompt override read failed for ${category}/${normalizedPromptId} at ${resolver.layer}:`,
            error
          );
          continue;
        }

        throw error;
      }
    }

    this.cache.set(cacheKey, null);
    return undefined;
  }

  async resolveAtLayer(
    category: PromptCategory,
    promptId: string,
    layer: PromptSourceLayer,
    profileId?: string
  ): Promise<string | undefined> {
    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const resolver = this.resolvers.find((candidate) => candidate.layer === layer);
    if (!resolver) {
      return undefined;
    }

    try {
      const entry = await resolver.resolve(category, normalizedPromptId, profileId);
      return entry?.content;
    } catch (error) {
      if (resolver.layer !== "builtin") {
        console.warn(
          `[swarm] Prompt override read failed for ${category}/${normalizedPromptId} at ${resolver.layer}:`,
          error
        );
        return undefined;
      }

      throw error;
    }
  }

  async listAll(profileId?: string): Promise<PromptEntry[]> {
    const categories: PromptCategory[] = ["archetype", "operational"];
    const entries: PromptEntry[] = [];

    for (const category of categories) {
      const promptIds = new Set<string>();

      for (const resolver of this.resolvers) {
        try {
          const ids = await resolver.listPromptIds(category, profileId);
          for (const id of ids) {
            promptIds.add(normalizePromptIdForCategory(category, id));
          }
        } catch (error) {
          if (resolver.layer !== "builtin") {
            console.warn(
              `[swarm] Prompt override listing failed for ${category} at ${resolver.layer}:`,
              error
            );
            continue;
          }

          throw error;
        }
      }

      const sortedPromptIds = Array.from(promptIds).sort((left, right) => left.localeCompare(right));
      for (const id of sortedPromptIds) {
        const entry = await this.resolveEntry(category, id, profileId);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    return entries.sort((left, right) => {
      if (left.category !== right.category) {
        return left.category.localeCompare(right.category);
      }
      return left.promptId.localeCompare(right.promptId);
    });
  }

  async save(category: PromptCategory, promptId: string, content: string, profileId: string): Promise<void> {
    if (content.trim().length === 0) {
      throw new Error(`Prompt override content must be non-empty: ${category}/${promptId}`);
    }

    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const directoryPath = buildProfilePromptDirectory(this.options.dataDir, category, profileId);
    const profilePath = buildProfilePromptPath(this.options.dataDir, category, normalizedPromptId, profileId);

    await mkdir(directoryPath, { recursive: true });
    await writeFile(profilePath, content, "utf8");
    this.invalidate(category, normalizedPromptId);
    void this.options.versioning?.recordMutation({
      path: profilePath,
      action: "write",
      source: "prompt-save",
      profileId,
      promptCategory: category,
      promptId: normalizedPromptId
    }).catch(() => {
      // Fail open: prompt writes succeed even when versioning cannot record them.
    });
  }

  async deleteOverride(category: PromptCategory, promptId: string, profileId: string): Promise<void> {
    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const profilePath = buildProfilePromptPath(this.options.dataDir, category, normalizedPromptId, profileId);

    try {
      await unlink(profilePath);
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    this.invalidate(category, normalizedPromptId);
    void this.options.versioning?.recordMutation({
      path: profilePath,
      action: "delete",
      source: "prompt-delete",
      profileId,
      promptCategory: category,
      promptId: normalizedPromptId
    }).catch(() => {
      // Fail open: prompt deletes succeed even when versioning cannot record them.
    });
  }

  async hasOverride(category: PromptCategory, promptId: string, profileId: string): Promise<boolean> {
    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const profilePath = buildProfilePromptPath(this.options.dataDir, category, normalizedPromptId, profileId);

    try {
      await access(profilePath);
      return true;
    } catch (error) {
      if (isEnoentError(error)) {
        return false;
      }
      throw error;
    }
  }

  invalidate(category?: PromptCategory, promptId?: string): void {
    if (!category && !promptId) {
      this.cache.clear();
      return;
    }

    for (const cacheKey of Array.from(this.cache.keys())) {
      const [cachedCategory, cachedPromptId] = cacheKey.split("|", 3);
      if (category && cachedCategory !== category) {
        continue;
      }

      if (promptId) {
        const categoryForNormalization = (cachedCategory === "operational" ? "operational" : "archetype") as PromptCategory;
        const normalizedPromptId = normalizePromptIdForCategory(categoryForNormalization, promptId);
        if (cachedPromptId !== normalizedPromptId) {
          continue;
        }
      }

      this.cache.delete(cacheKey);
    }
  }

  private buildCacheKey(category: PromptCategory, promptId: string, profileId?: string): string {
    const profileKey = profileId?.trim() ?? "";
    return `${category}|${promptId}|${profileKey}`;
  }
}

export class ProfilePromptResolver implements PromptResolver {
  readonly layer = "profile" as const;

  constructor(private readonly dataDir: string) {}

  async resolve(
    category: PromptCategory,
    promptId: string,
    profileId?: string
  ): Promise<PromptEntry | undefined> {
    if (!profileId) {
      return undefined;
    }

    const filePath = buildProfilePromptPath(this.dataDir, category, promptId, profileId);
    return readPromptEntry(filePath, this.layer, category, promptId);
  }

  async listPromptIds(category: PromptCategory, profileId?: string): Promise<string[]> {
    if (!profileId) {
      return [];
    }

    const directoryPath = buildProfilePromptDirectory(this.dataDir, category, profileId);
    return listMarkdownPromptIds(directoryPath, category);
  }
}

export class RepoPromptResolver implements PromptResolver {
  readonly layer = "repo" as const;

  constructor(private readonly repoDir: string) {}

  async resolve(
    category: PromptCategory,
    promptId: string,
    _profileId?: string
  ): Promise<PromptEntry | undefined> {
    if (category !== "archetype") {
      return undefined;
    }

    const normalizedArchetypeId = normalizeArchetypeId(promptId);
    if (!normalizedArchetypeId) {
      return undefined;
    }

    const filePath = join(this.repoDir, ".swarm", "archetypes", `${normalizedArchetypeId}.md`);
    return readPromptEntry(filePath, this.layer, category, normalizedArchetypeId);
  }

  async listPromptIds(category: PromptCategory): Promise<string[]> {
    if (category !== "archetype") {
      return [];
    }

    const directoryPath = join(this.repoDir, ".swarm", "archetypes");
    return listMarkdownPromptIds(directoryPath, category);
  }
}

export class BuiltinPromptResolver implements PromptResolver {
  readonly layer = "builtin" as const;
  private readonly archetypeDirs: string[];
  private readonly operationalDirs: string[];

  constructor(options: PromptRegistryOptions) {
    this.archetypeDirs = dedupePaths([
      options.builtinArchetypesDir,
      join(PROMPT_REGISTRY_DIR, "archetypes", "builtins"),
      join(BACKEND_PACKAGE_DIR, "src", "swarm", "archetypes", "builtins")
    ]);

    this.operationalDirs = dedupePaths([
      options.builtinOperationalDir,
      join(PROMPT_REGISTRY_DIR, "operational", "builtins"),
      join(BACKEND_PACKAGE_DIR, "src", "swarm", "operational", "builtins")
    ]);
  }

  async resolve(
    category: PromptCategory,
    promptId: string,
    _profileId?: string
  ): Promise<PromptEntry | undefined> {
    const normalizedPromptId = normalizePromptIdForCategory(category, promptId);
    const candidateDirectories = category === "archetype" ? this.archetypeDirs : this.operationalDirs;

    for (const directoryPath of candidateDirectories) {
      const filePath = join(directoryPath, `${normalizedPromptId}.md`);
      try {
        const content = await readFile(filePath, "utf8");
        return toPromptEntry(content, filePath, this.layer, category, normalizedPromptId);
      } catch (error) {
        if (isEnoentError(error)) {
          continue;
        }

        throw error;
      }
    }

    return undefined;
  }

  async listPromptIds(category: PromptCategory): Promise<string[]> {
    const promptIds = new Set<string>();
    const candidateDirectories = category === "archetype" ? this.archetypeDirs : this.operationalDirs;

    for (const directoryPath of candidateDirectories) {
      let entries: Dirent[];
      try {
        entries = await readdir(directoryPath, { withFileTypes: true });
      } catch (error) {
        if (isEnoentError(error)) {
          continue;
        }

        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }

        const withoutExtension = entry.name.slice(0, -3);
        const normalizedId = normalizePromptIdForCategory(category, withoutExtension);
        if (normalizedId) {
          promptIds.add(normalizedId);
        }
      }
    }

    return Array.from(promptIds).sort((left, right) => left.localeCompare(right));
  }
}

export function normalizeArchetypeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolvePromptVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_]+)\}/g, (match, name) => variables[name] ?? match);
}

function normalizePromptIdForCategory(category: PromptCategory, promptId: string): string {
  if (category === "archetype") {
    const normalized = normalizeArchetypeId(promptId);
    if (!normalized) {
      throw new Error(`Invalid archetype prompt id: ${promptId}`);
    }

    return normalized;
  }

  const normalized = promptId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error(`Invalid operational prompt id: ${promptId}`);
  }

  return normalized;
}

function dedupePaths(paths: string[]): string[] {
  const unique = new Set<string>();

  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    unique.add(trimmed);
  }

  return Array.from(unique);
}

function buildProfilePromptDirectory(dataDir: string, category: PromptCategory, profileId: string): string {
  const sanitizedProfileId = sanitizePathSegment(profileId);
  return join(
    dataDir,
    "profiles",
    sanitizedProfileId,
    "prompts",
    category === "archetype" ? "archetypes" : "operational"
  );
}

function buildProfilePromptPath(dataDir: string, category: PromptCategory, promptId: string, profileId: string): string {
  const directoryPath = buildProfilePromptDirectory(dataDir, category, profileId);
  const sanitizedPromptId = sanitizePathSegment(promptId);
  return join(directoryPath, `${sanitizedPromptId}.md`);
}

async function readPromptEntry(
  filePath: string,
  sourceLayer: PromptSourceLayer,
  category: PromptCategory,
  promptId: string
): Promise<PromptEntry | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return toPromptEntry(content, filePath, sourceLayer, category, promptId);
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function listMarkdownPromptIds(directoryPath: string, category: PromptCategory): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }

  const promptIds = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    const withoutExtension = entry.name.slice(0, -3);
    const normalized = normalizePromptIdForCategory(category, withoutExtension);
    if (normalized) {
      promptIds.add(normalized);
    }
  }

  return Array.from(promptIds).sort((left, right) => left.localeCompare(right));
}

function toPromptEntry(
  content: string,
  sourcePath: string,
  sourceLayer: PromptSourceLayer,
  category: PromptCategory,
  promptId: string
): PromptEntry {
  const normalizedContent = category === "archetype" ? content.trim() : content;
  if (normalizedContent.trim().length === 0) {
    throw new Error(`Prompt for ${category}/${promptId} is empty: ${sourcePath}`);
  }

  return {
    category,
    promptId,
    content: normalizedContent,
    sourceLayer,
    sourcePath
  };
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

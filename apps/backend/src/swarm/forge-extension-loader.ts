import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import type {
  DiscoveredForgeExtension,
  ForgeExtensionLoadFailure,
  LoadedForgeExtensionModule
} from "./forge-extension-types.js";

const extensionModuleCache = new Map<string, CachedForgeExtensionModule>();

export async function loadForgeExtensionModule(
  discovered: DiscoveredForgeExtension
): Promise<LoadedForgeExtensionModule> {
  const cacheKey = createExtensionCacheKey(discovered.path);
  const signature = await readExtensionFileSignature(discovered.path);
  const cached = extensionModuleCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return {
      discovered,
      setup: cached.setup,
      metadata: cached.metadata
    };
  }

  const importedModule = await importForgeExtensionModule(discovered.path);
  const namespace = toModuleNamespace(importedModule);
  const defaultExport = resolveDefaultExport(importedModule, namespace);
  if (typeof defaultExport !== "function") {
    throw new Error("Forge extension default export must be a function");
  }

  const metadata = validateExtensionMetadata(namespace.extension);
  const loadedModule = {
    signature,
    setup: defaultExport as (forge: unknown) => void | Promise<void>,
    metadata
  } satisfies CachedForgeExtensionModule;
  extensionModuleCache.set(cacheKey, loadedModule);

  return {
    discovered,
    setup: loadedModule.setup,
    metadata: loadedModule.metadata
  };
}

export async function loadForgeExtensionModules(discovered: readonly DiscoveredForgeExtension[]): Promise<{
  loaded: LoadedForgeExtensionModule[];
  errors: ForgeExtensionLoadFailure[];
}> {
  const loaded: LoadedForgeExtensionModule[] = [];
  const errors: ForgeExtensionLoadFailure[] = [];

  for (const entry of discovered) {
    try {
      loaded.push(await loadForgeExtensionModule(entry));
    } catch (error) {
      errors.push({
        discovered: entry,
        error: normalizeErrorMessage(error)
      });
    }
  }

  return { loaded, errors };
}

async function importForgeExtensionModule(path: string): Promise<unknown> {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false
  });

  try {
    return await jiti.import(path);
  } catch (error) {
    throw new Error(normalizeErrorMessage(error));
  }
}

async function readExtensionFileSignature(path: string): Promise<string> {
  try {
    const file = await stat(path);
    return `${file.mtimeMs}:${file.size}`;
  } catch (error) {
    throw new Error(normalizeErrorMessage(error));
  }
}

function createExtensionCacheKey(path: string): string {
  const resolvedPath = resolve(path);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

interface CachedForgeExtensionModule {
  readonly signature: string;
  readonly setup: (forge: unknown) => void | Promise<void>;
  readonly metadata: {
    readonly name?: string;
    readonly description?: string;
  };
}

function toModuleNamespace(value: unknown): Record<string, unknown> {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    return value as Record<string, unknown>;
  }

  return {};
}

function resolveDefaultExport(value: unknown, namespace: Record<string, unknown>): unknown {
  if (typeof value === "function") {
    return value;
  }

  if ("default" in namespace) {
    return namespace.default;
  }

  return undefined;
}

function validateExtensionMetadata(value: unknown): { name?: string; description?: string } {
  if (value === undefined) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error("Forge extension named export 'extension' must be an object when provided");
  }

  const metadata: { name?: string; description?: string } = {};

  if (typeof value.name === "string" && value.name.trim().length > 0) {
    metadata.name = value.name.trim();
  } else if (value.name !== undefined) {
    throw new Error("Forge extension metadata field 'name' must be a string when provided");
  }

  if (typeof value.description === "string" && value.description.trim().length > 0) {
    metadata.description = value.description.trim();
  } else if (value.description !== undefined) {
    throw new Error("Forge extension metadata field 'description' must be a string when provided");
  }

  return metadata;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unknown Forge extension load error";
}

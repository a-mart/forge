import { createJiti } from "jiti";
import type {
  DiscoveredForgeExtension,
  ForgeExtensionLoadFailure,
  LoadedForgeExtensionModule
} from "./forge-extension-types.js";

export async function loadForgeExtensionModule(
  discovered: DiscoveredForgeExtension
): Promise<LoadedForgeExtensionModule> {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false
  });

  let importedModule: unknown;
  try {
    importedModule = await jiti.import(discovered.path);
  } catch (error) {
    throw new Error(normalizeErrorMessage(error));
  }

  const namespace = toModuleNamespace(importedModule);
  const defaultExport = resolveDefaultExport(importedModule, namespace);
  if (typeof defaultExport !== "function") {
    throw new Error("Forge extension default export must be a function");
  }

  const metadata = validateExtensionMetadata(namespace.extension);

  return {
    discovered,
    setup: defaultExport as (forge: unknown) => void | Promise<void>,
    metadata
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

function toModuleNamespace(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value === "function") {
    return { default: value };
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

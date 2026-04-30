import { normalizeSpecialistHandle } from "../swarm/specialists/specialist-registry.js";

export const DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES = [
  "collab-planner",
  "collab-reviewer",
  "collab-doc-writer",
  "collab-scout",
  "collab-researcher",
] as const;

export type CollaborationSpecialistHandleList = string[];

export function serializeCollaborationSpecialistHandles(handles: readonly string[]): string {
  return JSON.stringify(normalizeCollaborationSpecialistHandles(handles));
}

export function normalizeCollaborationSpecialistHandles(handles: readonly string[]): CollaborationSpecialistHandleList {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawHandle of handles) {
    if (typeof rawHandle !== "string") {
      throw new Error("specialist handle lists must contain only strings");
    }

    const handle = normalizeSpecialistHandle(rawHandle);
    if (!handle) {
      throw new Error(`Invalid specialist handle: ${rawHandle}`);
    }

    if (!seen.has(handle)) {
      seen.add(handle);
      normalized.push(handle);
    }
  }

  return normalized;
}

export function parseCollaborationSpecialistHandlesJson(
  value: string | null | undefined,
  fallback: readonly string[] = DEFAULT_COLLAB_SELECTED_SPECIALIST_HANDLES,
): CollaborationSpecialistHandleList {
  if (value == null) {
    return [...fallback];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid specialist handles JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("specialist handles JSON must be an array");
  }

  return normalizeCollaborationSpecialistHandles(parsed);
}

export function findMissingCollaborationSpecialistHandles(
  selectedHandles: readonly string[],
  availableHandles: Iterable<string> | undefined,
): string[] | undefined {
  if (!availableHandles) {
    return undefined;
  }

  const available = new Set([...availableHandles].map((handle) => normalizeSpecialistHandle(handle)).filter(Boolean));
  const missing = selectedHandles.filter((handle) => !available.has(handle));
  return missing.length > 0 ? missing : undefined;
}

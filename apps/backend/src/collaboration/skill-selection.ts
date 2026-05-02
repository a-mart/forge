export type CollaborationSkillHandleList = string[];
export type CollaborationSkillSelectionMode = "all" | "custom";

export const COLLABORATION_ALWAYS_ON_SKILL_HANDLES = ["memory"] as const;

export type CollaborationSkillSelectionInput =
  | { mode: "all" }
  | { mode: "custom"; savedSelectedSkillHandles: string[] };

export function normalizeCollaborationSkillHandle(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeCollaborationSkillHandles(handles: readonly unknown[]): CollaborationSkillHandleList {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawHandle of handles) {
    if (typeof rawHandle !== "string") {
      throw new Error("skill handle lists must contain only strings");
    }

    const handle = normalizeCollaborationSkillHandle(rawHandle);
    if (!handle) {
      throw new Error("skill handles must be non-empty strings");
    }

    if (!seen.has(handle)) {
      seen.add(handle);
      normalized.push(handle);
    }
  }

  return normalized;
}

export function normalizeCollaborationOptionalSkillHandles(handles: readonly unknown[]): CollaborationSkillHandleList {
  const alwaysOnHandles = new Set(COLLABORATION_ALWAYS_ON_SKILL_HANDLES.map(normalizeCollaborationSkillHandle));
  return normalizeCollaborationSkillHandles(handles).filter((handle) => !alwaysOnHandles.has(handle));
}

export function serializeCollaborationSkillHandles(handles: readonly string[]): string {
  return JSON.stringify(normalizeCollaborationOptionalSkillHandles(handles));
}

export function parseCollaborationSkillHandlesJson(
  value: string | null | undefined,
): CollaborationSkillHandleList | null {
  if (value == null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid skill handles JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("skill handles JSON must be an array");
  }

  return normalizeCollaborationSkillHandles(parsed);
}

export function resolveCollaborationSkillSelectionMode(
  value: string | null | undefined,
): CollaborationSkillSelectionMode {
  return parseCollaborationSkillHandlesJson(value) === null ? "all" : "custom";
}

export function serializeCollaborationSkillSelectionInput(
  selection: CollaborationSkillSelectionInput | undefined,
): string | null | undefined {
  if (selection === undefined) {
    return undefined;
  }

  if (selection.mode === "all") {
    return null;
  }

  return serializeCollaborationSkillHandles(selection.savedSelectedSkillHandles);
}

export function findMissingCollaborationSkillHandles(
  selectedHandles: readonly string[],
  availableHandles: Iterable<string> | undefined,
): string[] | undefined {
  if (!availableHandles) {
    return undefined;
  }

  const available = new Set(
    [...availableHandles]
      .map((handle) => normalizeCollaborationSkillHandle(handle))
      .filter(Boolean),
  );
  const alwaysOnHandles = new Set(COLLABORATION_ALWAYS_ON_SKILL_HANDLES.map(normalizeCollaborationSkillHandle));
  const missing = selectedHandles.filter((handle) => {
    const normalized = normalizeCollaborationSkillHandle(handle);
    return !alwaysOnHandles.has(normalized) && !available.has(normalized);
  });
  return missing.length > 0 ? missing : undefined;
}

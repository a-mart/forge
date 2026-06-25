/**
 * Raw Pi session-entry scan helpers for compaction records.
 *
 * These operate on untyped session manager entries and key compaction rows by
 * stable id when present, otherwise by session index. Callers must supply an
 * explicit before-snapshot set; an empty/missing snapshot must not be treated
 * as "all historical compactions are new".
 */

export interface CompactionSessionEntryRef {
  key: string;
  id?: string;
}

export function collectCompactionEntryKeys(entries: readonly unknown[]): Set<string> {
  const keys = new Set<string>();

  entries.forEach((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    const record = entry as Record<string, unknown>;
    if (record.type !== "compaction") {
      return;
    }

    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
    keys.add(id ? `id:${id}` : `index:${index}`);
  });

  return keys;
}

export function findNewCompactionEntries(
  entries: readonly unknown[],
  previousKeys: ReadonlySet<string>,
): CompactionSessionEntryRef[] {
  const next: CompactionSessionEntryRef[] = [];

  entries.forEach((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    const record = entry as Record<string, unknown>;
    if (record.type !== "compaction") {
      return;
    }

    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
    const key = id ? `id:${id}` : `index:${index}`;
    if (!previousKeys.has(key)) {
      next.push({ key, id });
    }
  });

  return next;
}

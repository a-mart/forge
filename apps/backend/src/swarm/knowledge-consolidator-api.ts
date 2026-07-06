import type { KnowledgeEntry, KnowledgeService } from "./knowledge-service.js";

export interface KnowledgeConsolidatorApi {
  merge(sourceIds: string[]): Promise<KnowledgeEntry>;
  archive(id: string): Promise<KnowledgeEntry>;
  reindex(): Promise<void>;
}

export function createKnowledgeConsolidatorApi(service: KnowledgeService): KnowledgeConsolidatorApi {
  return {
    async merge(sourceIds: string[]): Promise<KnowledgeEntry> {
      const ids = sourceIds.map((id) => id.trim()).filter(Boolean);
      if (ids.length < 2) {
        throw new Error("merge requires at least two source ids");
      }
      const entries = await Promise.all(ids.map((id) => service.readEntry(id)));
      const primary = entries[0];
      const mergedSources = entries.flatMap((entry) => entry.frontmatter.sources);
      const mergedSupersedes = Array.from(new Set(entries.flatMap((entry) => entry.frontmatter.supersedes)));
      const sourceEntryIds = Array.from(new Set([...ids, ...entries.flatMap((entry) => entry.frontmatter.source_entry_ids)]));
      const merged = await service.upsertEntry({
        id: primary.frontmatter.id,
        type: primary.frontmatter.type,
        scope: primary.frontmatter.scope,
        title: primary.frontmatter.title,
        body: primary.body,
        evidenceTier: primary.frontmatter.evidence_tier,
        sources: mergedSources,
        importance: primary.frontmatter.importance,
        supersedes: mergedSupersedes,
        sourceEntryIds,
        expectedVersion: primary.frontmatter.version,
      });

      for (const entry of entries.slice(1)) {
        await service.archiveEntry(entry.frontmatter.id);
      }

      return merged;
    },
    archive(id: string): Promise<KnowledgeEntry> {
      return service.archiveEntry(id);
    },
    async reindex(): Promise<void> {
      const scopes = new Set((await service.searchEntries({ scope: "all", limit: 100 })).map((entry) => entry.scope));
      await service.regenerateIndex("global");
      for (const scope of scopes) {
        await service.regenerateIndex(scope);
      }
    },
  };
}

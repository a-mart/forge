**Settings → History** is local Builder only. It shows indexing activity for agent-only history recall and can pause or resume that work. Restricted runtimes, Remote Projects, and Collaboration history are not included.

History search is not a toggle. Indexing starts on its own after local Builder hydration. Pause stops indexing; it does not enable or disable search, stop conversation recording, or rebuild or delete the cache.

## Indexing

The badge reports current activity: **Starting**, **Indexing**, **Indexing complete**, **Paused**, or **Unavailable**. Use **Refresh** to reload diagnostics immediately. While this page is visible, status also refreshes every five seconds.

**Pause indexing** waits for the current bounded indexing work, then stops background indexing and the extra catch-up that search and read would otherwise trigger. The preference is saved in `shared/config/history-index.json` and survives restart. Conversations keep recording. Cached search hits and direct conversation reads stay available, but newer content may be missing from indexed search. Browsing context windows, listing earlier messages, and literal scans of canonical history remain available without advancing the index.

**Resume indexing** saves the preference as running and schedules catch-up without resetting the index. If the saved preference file is unreadable or malformed, indexing stays paused until you resume and Forge can save a new preference. A failed save leaves the previous preference unchanged.

## Indexing progress

This section reports disk size and discovered-source coverage:

- **Index on disk** and **Write-ahead log**
- **Known transcript data** and **Transcript data scanned**
- **Sources discovered** and **Discovered sources awaiting work**

Byte counts describe discovered canonical data, not searchable text or an estimate of the entire corpus. Sizes are rounded. Scanned bytes include content excluded from search, so matching totals do not mean all content is searchable.

## Search availability

What can appear in search is separate from whether indexing has finished. Pending indexing work alone does not mean search is limited.

When sources are actually missing, unreadable, or omitted by indexing safety limits, this section lists those counts. If the badge is **Indexing complete**, those limitations are not pending indexing work.

## About this index

This section shows schema version, catalog discovery, and last cache update. Canonical conversation JSONL remains the source of truth. `shared/cache/history-recall.db` is a rebuildable cache with no embeddings and no human history drawer. This page does not return transcript contents, rebuild or delete the cache, or change Summary/Fresh policy.

See **Project Settings → Context management** for continuation policy, and compaction help for how agents use the `history` tool.

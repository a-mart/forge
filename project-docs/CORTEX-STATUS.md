# Cortex Knowledge Agent — Full Status & Continuity Document

> Written 2026-03-04. Reference this after context compaction to get fully caught up.

## What Cortex Is

Cortex is a **singleton super-manager agent** that reviews ALL profiles' sessions, extracts patterns/preferences/decisions, and maintains knowledge files that get injected into other managers' contexts. It's the "intelligence layer" — the brain's outer cortex that does higher-order pattern recognition across the entire system.

**Core principle:** Cortex is a manager with a good prompt, not a service layer. Zero custom tools, zero new services. The prompt IS the product.

## Worktree & Branch

- **Worktree**: `/Users/adam/repos/middleman-cortex`
- **Branch**: `feat/cortex`
- **Base**: Merged with `origin/main` as of `c8bec51` (includes compaction fallback fix)
- **NOT merged to dev/main** — requires explicit user approval

## What's Implemented & Working

### Backend (all committed + uncommitted dashboard work)

| Feature | Status | Files |
|---------|--------|-------|
| Singleton auto-create on boot | ✅ | `swarm-manager.ts` (`ensureCortexProfile()`) |
| Singleton guards (reject dup create, reject delete) | ✅ | `swarm-manager.ts` |
| Common knowledge injection into all profiles | ✅ | `swarm-manager.ts` (`getMemoryRuntimeResources()`) |
| Session tracking (cortexReviewedAt/Bytes in meta.json) | ✅ | `session-manifest.ts`, `shared-types.ts` |
| Scan script (prioritized session review list) | ✅ | `swarm/scripts/cortex-scan.ts` |
| Scan refactored to export structured `ScanResult` | ✅ | `swarm/scripts/cortex-scan.ts` |
| Cortex archetype prompt (178 lines) | ✅ | `swarm/archetypes/builtins/cortex.md` |
| `GET /api/cortex/scan` endpoint | ✅ | `ws/routes/cortex-routes.ts` |
| `POST /api/write-file` endpoint | ✅ | `ws/routes/file-routes.ts` |
| Data path helpers | ✅ | `data-paths.ts` (getCommonKnowledgePath, getCortexNotesPath, getSharedKnowledgeDir) |

### Frontend (all in worktree, uncommitted dashboard work)

| Feature | Status | Files |
|---------|--------|-------|
| Pinned brain icon in sidebar | ✅ | `AgentSidebar.tsx` |
| Worker expand/collapse under Cortex | ✅ | `AgentSidebar.tsx` |
| Context menu: hide Delete for Cortex | ✅ | `AgentSidebar.tsx` |
| `isCortexProfile()` helper | ✅ | `agent-hierarchy.ts` |
| CortexDashboardPanel (replaces ArtifactsSidebar for Cortex) | ✅ | `components/chat/cortex/CortexDashboardPanel.tsx` |
| KnowledgeFileViewer (read + edit mode) | ✅ | `components/chat/cortex/KnowledgeFileViewer.tsx` |
| ReviewStatusPanel (scan results display) | ✅ | `components/chat/cortex/ReviewStatusPanel.tsx` |
| Resizable panel (300-700px, localStorage persisted) | ✅ | `CortexDashboardPanel.tsx` |
| Auto-refresh on tab switch/panel open | ✅ | `CortexDashboardPanel.tsx` (key-based remount) |
| ChatHeader tooltip: "Dashboard" when Cortex active | ✅ | `ChatHeader.tsx` |

### Protocol

| Feature | Status | Files |
|---------|--------|-------|
| SessionMeta extended with cortexReviewed* fields | ✅ | `packages/protocol/src/shared-types.ts` |

### Tests

- **Backend**: 228 tests passing (27 files) — includes cortex-scan, singleton guards, scan endpoint, write-file endpoint
- **Frontend**: 48 tests passing (7 files)
- **Total**: 276 tests
- **Typecheck**: Clean across all packages

## Test Environment

- **Data dir**: `~/.middleman-cortex-test` (3.5GB copy of production data, 19 sessions)
- **Backend**: port 47487, env `MIDDLEMAN_DATA_DIR=~/.middleman-cortex-test MIDDLEMAN_PORT=47487`
- **UI**: port 47488, built with `VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487`
- **PIDs**: `/tmp/cortex-backend.pid`, `/tmp/cortex-ui.pid`
- **Kill**: `kill $(cat /tmp/cortex-backend.pid) $(cat /tmp/cortex-ui.pid)`
- **Auth**: Synced from production (`~/.middleman/shared/auth/auth.json` → both auth paths in test dir)
- **Server logs**: `/tmp/cortex-server.log`, `/tmp/cortex-ui.log`

### CRITICAL: Test Environment Procedure

1. UI WS URL env var is `VITE_MIDDLEMAN_WS_URL` (NOT `VITE_WS_URL`)
2. Without it, the UI silently connects to production backend (port 47287)
3. Always rebuild UI with explicit WS URL, verify no production port refs in build output
4. Backend port env var is `MIDDLEMAN_PORT` (not `PORT`)
5. Use `nohup` for background processes (bare `&` dies on shell timeout)
6. Production ports: 47187/47188 (dev), 47287/47289 (prod) — NEVER use for test

## What's In Progress

### Per-Profile Knowledge (being planned now)
- **Goal**: Cortex maintains project-level knowledge for each profile (e.g., feature-manager gets agent_stack-specific knowledge, middleman-project gets middleman-specific knowledge)
- **Injection**: Per-profile knowledge injected alongside common.md but only into that profile's sessions
- **Planning worker**: `cortex-profile-knowledge-plan` (Opus) writing plan to `/tmp/cortex-profile-knowledge-plan.md`
- **Touches**: data-paths, injection logic, cortex.md prompt, dashboard UI, scan endpoint

## What's NOT Done Yet

- [ ] Final merge to dev/main (requires user approval)
- [ ] Extended prompt tuning after real-world testing
- [ ] Polish: panel resize persistence edge cases, auto-refresh intervals, TOC for large knowledge files

## Git Status (as of 2026-03-04)

All work committed on `feat/cortex` branch:
```
a961750 feat: per-profile knowledge — injection, prompt triage, and dashboard selector
6f2f874 feat: Cortex dashboard panel with knowledge viewer, file editing, and review status
c8bec51 Merge remote-tracking branch 'origin/main' into feat/cortex
038c7fc feat: Cortex Knowledge Agent — singleton super-manager with auto-boot, session scanning, and common knowledge injection
```

### Per-Profile Knowledge (implemented in a961750)
- **Data layout**: `shared/knowledge/profiles/<profileId>.md`
- **Injection**: After common.md in `getMemoryRuntimeResources()`, labeled "Project Knowledge for <profileId>"
- **Prompt**: Knowledge triage section — common vs profile rules, profile knowledge structure template (215 lines total)
- **Dashboard**: Knowledge tab dropdown selector (Common / per-profile), file size indicators
- **Scan endpoint**: Returns `files.profileKnowledge` map with path/exists/sizeBytes per profile
- **Tests**: 277 total (229 backend + 48 UI)

## Key Architecture Decisions

1. **Cortex is a manager with a good prompt** — no custom tools, no new services
2. **Singleton enforced at backend** — createManager() rejects duplicates, deleteManager() prevents deletion
3. **Common knowledge = new data tier** — `shared/knowledge/common.md` injected into ALL profiles at runtime
4. **Scan script via bash** — Cortex runs it like any manager runs bash commands
5. **Session tracking via meta.json** — cortexReviewedAt + cortexReviewedBytes fields
6. **Dashboard replaces ArtifactsSidebar** — only when Cortex is active, via `archetypeId === 'cortex'`
7. **Direct edit + ask Cortex** — dual paths for knowledge corrections

## Key Files Reference

```
# Backend - Core
apps/backend/src/swarm/swarm-manager.ts          # ensureCortexProfile(), singleton guards, knowledge injection
apps/backend/src/swarm/data-paths.ts              # getCommonKnowledgePath(), getCortexNotesPath(), getSharedKnowledgeDir()
apps/backend/src/swarm/scripts/cortex-scan.ts     # scanCortexReviewStatus() + CLI
apps/backend/src/swarm/session-manifest.ts        # cortexReviewed* field preservation
apps/backend/src/swarm/archetypes/builtins/cortex.md  # THE PROMPT (178 lines)
apps/backend/src/swarm/archetypes/archetype-prompt-registry.ts  # cortex archetype registration

# Backend - Routes
apps/backend/src/ws/routes/cortex-routes.ts       # GET /api/cortex/scan
apps/backend/src/ws/routes/file-routes.ts          # POST /api/write-file (new), read-file (existing)
apps/backend/src/ws/server.ts                      # route registration

# Frontend - Cortex Dashboard
apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx   # main panel, 3 tabs, resizable
apps/ui/src/components/chat/cortex/KnowledgeFileViewer.tsx    # read/edit markdown files
apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx      # scan results display

# Frontend - Sidebar
apps/ui/src/components/chat/AgentSidebar.tsx       # pinned Cortex entry, worker visibility
apps/ui/src/lib/agent-hierarchy.ts                 # isCortexProfile() helper

# Frontend - Integration
apps/ui/src/routes/index.tsx                       # conditional CortexDashboardPanel vs ArtifactsSidebar
apps/ui/src/components/chat/ChatHeader.tsx          # "Dashboard" tooltip for Cortex

# Protocol
packages/protocol/src/shared-types.ts              # SessionMeta cortexReviewed* fields

# Tests
apps/backend/src/test/cortex-scan.test.ts
apps/backend/src/test/swarm-manager.test.ts
apps/backend/src/test/ws-server.test.ts
apps/backend/src/test/archetype-prompt-registry.test.ts
apps/backend/src/swarm/__tests__/data-paths.test.ts
```

## Related Artifacts

- Vision doc: `/Users/adam/repos/middleman/project-docs/design/KNOWLEDGE-CUSTODIAN-VISION.md`
- Simplified plan: `/tmp/cortex-plan-simplified.md`
- Dashboard plan: `/tmp/cortex-dashboard-plan.md`
- Dashboard brainstorms: `/tmp/cortex-dashboard-brainstorm-ux.md`, `/tmp/cortex-dashboard-brainstorm-backend.md`, `/tmp/cortex-dashboard-prior-art.md`
- Per-profile knowledge plan: `/tmp/cortex-profile-knowledge-plan.md` (being written)
- Codebase answers: `/tmp/cortex-codebase-answers.md`

## Recall System (separate track, on hold)

- Worktree: `/Users/adam/repos/middleman-recall` (branch `feat/context-recall`)
- 48 files, +6,124 lines, 240 tests
- BM25 search over conversation history
- Classified as supporting infrastructure, not headline feature
- Merge decision pending

# Ghost / stale active Playwright sessions investigation

## Bottom line
The bogus `default` tile is most likely **not coming from this `middleman` repo at all**. It is being discovered from an **unrelated agent cwd** (`/Users/adam/repos/newco/agent_stack`) because Playwright discovery currently scans roots inferred from **all agent descriptors**, not just the current repo/current manager.

In the concrete case I traced:
- the swarm registry contains worker `dev-docling-failure-investigator`
- that worker cwd is `/Users/adam/repos/newco/agent_stack`
- that cwd has `.playwright-cli/session` metadata including `default.session`, `pw-monitor-c.session`, and `pw-monitor-d.session`
- `/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock` is currently present and accepts connections
- the nested v2 `default.session` can answer `devtools-start`

So the `default` row is being surfaced because discovery sees a **live default Playwright daemon session in another project root** and correlates it back to that worker. From the dashboard user’s perspective it looks ghost/stale, but the backend is currently treating it as legitimately active.

## Highest-confidence root causes

### 1) Discovery scope is too broad
**Primary cause.**

`apps/backend/src/playwright/playwright-discovery-service.ts` seeds scan roots from:
- current repo root / allowlist
- explicit Playwright settings scan roots
- **all agent cwd values** via `this.swarmManager.listAgents()` + `discoverLikelyProjectRoots(agent.cwd)`

That means the main Playwright dashboard can pull in sessions from:
- other repos
- other worktrees
- other managers/profiles
- stale historical worker cwd locations

This is backend discovery logic, not frontend rendering.

### 2) “Active” currently means “socket accepts a raw connect”
`determineLiveness()` marks a session `active` when:
- socket path exists, and
- `probeSocket()` can connect

That is a weak liveness test. It does **not** prove the session is the one the user expects, only that something is listening on that socket.

In the traced case, that test is enough to make the unrelated `default` session look active.

### 3) Duplicate/preferred logic does not protect against this class of row
Duplicate grouping is keyed by:
- `socketPath ?? realPath`

That only dedupes exact same-socket duplicates.

In the `agent_stack` root there are two `default.session` files that share the same socket path, so only one `default` row survives as preferred. But `default`, `pw-monitor-c`, and `pw-monitor-d` are **different socket paths**, so preferred-group logic does **not** collapse the `default` row away.

So:
- duplicate logic is **not the root cause**
- but it also **does not prevent** a stale/unwanted `default` row from appearing beside named sessions

### 4) Tile spinner behavior is masking truth
`apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx` keeps a tile in loading state until the iframe posts `playwright:embed-status` = `active`.

There is no strong timeout/downgrade path after preview start. So if preview bootstrap partially succeeds but the embed never reports ready, the tile can spin indefinitely.

That is a frontend display issue, separate from discovery.

## Concrete evidence gathered

### Current `middleman` repo itself is not the source
In `/Users/adam/repos/middleman`:
- no local `.playwright-cli/sessions/*.session` files were present
- `git worktree list` showed only the main worktree

So the visible `default` tile is very unlikely to be sourced from this repo directly.

### Unrelated worker/root that matches the user report
Swarm registry entry found:
- agent: `dev-docling-failure-investigator`
- cwd: `/Users/adam/repos/newco/agent_stack`

That root contains:
- `.playwright-cli/sessions/3f15aae11982f048/default.session`
- `.playwright-cli/sessions/3f15aae11982f048/pw-monitor-c.session`
- `.playwright-cli/sessions/3f15aae11982f048/pw-monitor-d.session`

The active socket currently present is:
- `/tmp/playwright-cli-sockets/3f15aae11982f048/default.sock`

I verified:
- the socket exists
- a raw socket connect succeeds
- a `devtools-start` RPC returns a controller URL

That makes the `default` tile a **real but unrelated/disfavored session**, not a purely fabricated frontend ghost.

## Backend vs frontend?

### Backend discovery problem
Main issue:
- `apps/backend/src/playwright/playwright-discovery-service.ts`

Why:
- over-broad root discovery
- weak liveness classification
- duplicate grouping not aligned with what the dashboard should treat as the preferred visible row

### Frontend display problem
Secondary issue:
- `apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx`
- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`

Why:
- tiles can spin forever after optimistic preview start
- tile view does not add a stricter visibility rule for “safe to auto-preview” rows

## Recommended fix plan on main

### Phase 1 — fix discovery scope first
In `apps/backend/src/playwright/playwright-discovery-service.ts`:
1. **Stop scanning roots from every agent descriptor by default.**
   - Limit agent-derived roots to the current manager/session scope only, or
   - only scan explicit settings roots + current repo/worktree roots, or
   - at minimum exclude terminated/stopped agents and foreign-profile/foreign-manager roots.
2. Add a clear ownership boundary so the Playwright dashboard does not mix unrelated projects into one tile grid.

This is the highest-value fix.

### Phase 2 — strengthen active/previewable classification
Still in `apps/backend/src/playwright/playwright-discovery-service.ts`:
1. Split today’s `active` into something closer to:
   - `socket_alive`
   - `previewable`
   - or a stronger `active` that requires a successful higher-level probe
2. Do not let raw socket-connect alone imply “safe to show as active tile”.
3. Prefer v2 sessions with successful RPC/preview bootstrap over older or weaker metadata.

If protocol needs extra fields, update:
- `packages/protocol/src/playwright.ts`

### Phase 3 — tighten tile eligibility
In `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`:
1. For **tiles mode**, default to showing only rows that are:
   - preferred in duplicate group
   - previewable
   - and owned by the active discovery scope
2. Consider de-prioritizing unnamed `default` sessions when named sessions exist in the same root/daemon.

### Phase 4 — stop infinite spinners
In `apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx`:
1. Add a timeout after preview start.
2. If no `playwright:embed-status` arrives in time, switch to a failed/unavailable placeholder instead of spinning forever.

## Exact files likely needing changes
- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `packages/protocol/src/playwright.ts` (if adding stronger liveness / ownership fields)
- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx`
- `apps/backend/src/test/playwright-discovery-service.test.ts`
- likely frontend tests around tile filtering / loading behavior

## Recommended implementation priority
1. **Backend discovery scoping**
2. **Backend liveness/previewability tightening**
3. **Frontend tile filtering**
4. **Frontend spinner timeout/fallback**

## Final conclusion
The strongest explanation is:
- the main dashboard is discovering Playwright sessions from an unrelated worker cwd (`newco/agent_stack`)
- a `default` Playwright daemon socket in that root is genuinely still alive
- duplicate/preferred logic only dedupes exact same-socket rows, so it does not suppress that `default` row
- the tile UI can then sit in a perpetual spinner if the embed never reports ready

So this should be treated as **primarily a backend discovery/scoping bug**, with a **secondary frontend tile-state bug**.
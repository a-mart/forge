# E2E Reconnect + Session-Memory Persistence (CRT-06)

**Date:** 2026-03-15 (CDT)  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Isolation:** migrate sandbox only (`/Users/adam/.middleman-cortex-memory-v2-migrate`), no production writes  
**Backend port (isolated retry):** `47987` (explicitly avoiding `47587/47687/47887`)

## Scope
Bounded reconnect/session-memory probe for rubric item **CRT-06**:
- reconnect/reload persistence evidence via WebSocket re-subscribe + conversation-history replay
- direct evidence (if practical) that session-local memory survives reconnect

## Prior conflict note (do not loop)
A previous attempt targeted `47587` and hit an existing-listener conflict:
- `.tmp/e2e-crt06-backend.log` contains: `Failed to start backend: ws://0.0.0.0:47587 is already in use...`

This retry switched to unused port `47987` and proceeded.

## Probe setup
### Backend launch (isolated)
- `MIDDLEMAN_HOST=127.0.0.1`
- `MIDDLEMAN_PORT=47987`
- `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate`
- `NODE_ENV=production`
- log: `.tmp/e2e-crt06-r2-backend.log`

### Bounded API probe
- `GET http://127.0.0.1:47987/api/cortex/scan`
- captured snippet: `.tmp/e2e-crt06-r2-scan-snippet.json`

### Bounded WS reconnect probe
- script: `.tmp/e2e-crt06-reconnect-probe-r2.mjs`
- result: `.tmp/e2e-crt06-reconnect-result-r2.json`
- target manager/session: `ortho-invoice`

Flow:
1. Connect WS, subscribe, select `ortho-invoice`.
2. Send prompt instructing memory-skill write with unique token.
3. Wait for assistant acknowledgment, disconnect WS.
4. Reconnect WS, re-subscribe same session, verify replay includes token.
5. Ask assistant to recall token from session memory after reconnect.
6. Read session memory file before/after.

## Results
From `.tmp/e2e-crt06-reconnect-result-r2.json`:
- `token`: `CRT06_1773624973207`
- Assistant response #1: `CRT06_SAVED CRT06_1773624973207`
- Assistant response #2 (after reconnect): `CRT06_RECALL CRT06_1773624973207`
- Checks:
  - `memoryHadTokenBefore: false`
  - `memoryHasTokenAfterFirst: true`
  - `memoryHasTokenAfterSecond: true`
  - `memoryChangedAfterFirst: true`
  - `memoryChangedAfterSecond: false`
  - `reconnectHistoryContainsToken: true`
  - `reconnectHistoryMessageCount: 163`

Filesystem confirmation:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/ortho-invoice/sessions/ortho-invoice/memory.md`
  contains `CRT06_TOKEN=CRT06_1773624973207` after reconnect.

Backend reconnect telemetry:
- `.tmp/e2e-crt06-r2-backend.log` shows bootstrap-history replay on reconnect for `ortho-invoice` (`trimmedCount` increased from `156` to `163`).

## Rubric mapping
- **CRT-06 / Rubric 1.4 (Session memory persists across reconnects): PASS (migrate env)**
  - reconnect history replay observed
  - session-local memory file retained token across disconnect/reconnect
  - post-reconnect assistant recall matched persisted token

## Notes / caveats
- This capture is from the **migrate isolated env** only (not fresh).
- `session.jsonl` byte count stayed constant in this run; persistence verdict relies on memory-file and replay/recall checks above, not transcript-byte growth.

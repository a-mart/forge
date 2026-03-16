# Cortex Memory v2 — E2E Worker Callback Runtime (CRT-05)

Date: 2026-03-15/16 (CDT)
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
Isolated data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate` (copied-prod migrate env)
Backend port: `48187` (fresh; did **not** use 47587/47887/47987/48087)

## Goal
Prove real Cortex runtime delegation behavior for `CRT-05`: worker spawn + callback to manager, using a tiny bounded synthetic review-like task (no broad scans).

## Exact Commands

1) Start backend in isolated copied-prod env on fresh port:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && rm -f .tmp/e2e-worker-backend.pid .tmp/e2e-worker-backend.log && (MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate MIDDLEMAN_PORT=48187 pnpm --filter @middleman/backend exec tsx src/index.ts > .tmp/e2e-worker-backend.log 2>&1 & echo $! > .tmp/e2e-worker-backend.pid) && echo "launcher pid $(cat .tmp/e2e-worker-backend.pid)" && for i in {1..30}; do if curl -sf http://127.0.0.1:48187/api/health >/dev/null; then echo READY; break; fi; sleep 1; done && lsof -nP -iTCP:48187 -sTCP:LISTEN
```

2) Run deterministic CRT-05 WS harness (creates tiny synthetic Cortex session, then asks Cortex for bounded delegated review-like task with required callback token):
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-worker-callback-runtime.mjs
```

3) (Evidence extraction helper used for agents_snapshot delta):
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node - <<'NODE'
const fs=require('fs');
const p='planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.events.jsonl';
const lines=fs.readFileSync(p,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const snaps=lines.filter(l=>l.event.type==='agents_snapshot');
const ctx=snaps.map(s=>({index:s.index,workers:s.event.agents.filter(a=>a.role==='worker'&&a.managerId==='cortex').length,hasNew:s.event.agents.some(a=>a.agentId==='crt05-cortex-s13-worker')}));
console.log(JSON.stringify({snapshots:ctx.slice(-4)},null,2));
NODE
```

## Runtime Result
**PASS**

Run id: `crt05-worker-callback-2026-03-16T01-59-30-734Z`
Synthetic session: `cortex--s13`
Required callback token: `CRT05_WORKER_CALLBACK_OK:cortex--s13`

### Required Evidence Captured

1) **agents_snapshot shows worker creation** (delta from 160 -> 161 Cortex workers; new worker id observed)
- See: `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.snapshot-evidence.json`
- Key point: snapshot event index `39` has `hasNewWorker=true` and `newWorkerId="crt05-cortex-s13-worker"`.

2) **agent_message manager -> worker assignment**
- Raw event index `40` in:
  - `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.events.jsonl`
- Includes explicit bounded instructions and exact required callback token.

3) **agent_message worker -> manager callback completion**
- Raw event index `46` in:
  - `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.events.jsonl`
- `fromAgentId`: `crt05-cortex-s13-worker`
- `toAgentId`: `cortex`
- `text`: `CRT05_WORKER_CALLBACK_OK:cortex--s13`

4) **Tool-level completion evidence for callback action**
- Raw event index `47` (`agent_tool_call` end) confirms worker `send_message_to_agent` completed with queued delivery metadata.

## Artifacts

Summary JSON:
- `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.summary.json`

Raw WS event log (separate from summary):
- `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.events.jsonl`

agents_snapshot-focused extraction:
- `planning/cortex-memory-v2/raw/crt05-worker-callback-2026-03-16T01-59-30-734Z.snapshot-evidence.json`

Backend runtime log:
- `.tmp/e2e-worker-backend.log`

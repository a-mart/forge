# Remediation Plan: Idle Worker Watchdog + Context Pressure Amplification

## Scope
Fix the following in `apps/backend/src/swarm`:

1. **Idle worker watchdog amplification** (fan-out + verbose messages + no recovery awareness)
2. **No watchdog circuit breaker for repeated failures** (e.g., quota loops)
3. **Unbounded `list_agents` output**
4. **Message delivery during context recovery still steering into context**

---

## Files to Change

- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/agent-runtime.ts`
- `apps/backend/src/swarm/runtime-types.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/test/idle-worker-watchdog.test.ts`
- `apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts`
- `apps/backend/src/test/swarm-tools.test.ts`

(Optionally: `apps/backend/src/swarm/archetypes/builtins/manager.md` to document new `list_agents` defaults.)

---

## 1) `agent-runtime.ts`: Stop steering during recovery; buffer with cap, flush after recovery

### Problem
Current `sendMessage()` routes all busy states (streaming/prompt pending/**recovery**) through `enqueueMessage()`, which calls `session.steer()` immediately.

### Before
```ts
if (this.session.isStreaming || this.promptDispatchPending || this.contextRecoveryInProgress) {
  const resolvedQueueMode = "steer";
  await this.enqueueMessage(deliveryId, message);
  await this.emitStatus();
  return {
    targetAgentId: this.descriptor.agentId,
    deliveryId,
    acceptedMode: resolvedQueueMode
  };
}
```

### After (planned)
Split recovery handling from normal busy handling:

```ts
if (this.contextRecoveryInProgress) {
  this.bufferMessageDuringRecovery(deliveryId, message);
  await this.emitStatus();
  return {
    targetAgentId: this.descriptor.agentId,
    deliveryId,
    acceptedMode: "steer"
  };
}

if (this.session.isStreaming || this.promptDispatchPending) {
  await this.enqueueMessage(deliveryId, message);
  await this.emitStatus();
  return {
    targetAgentId: this.descriptor.agentId,
    deliveryId,
    acceptedMode: "steer"
  };
}
```

Add bounded recovery buffer + flush:

```ts
const MAX_RECOVERY_BUFFERED_MESSAGES = 25;

private readonly recoveryBufferedMessages: Array<{
  deliveryId: string;
  message: RuntimeUserMessage;
}> = [];

private bufferMessageDuringRecovery(deliveryId: string, message: RuntimeUserMessage): void {
  if (this.recoveryBufferedMessages.length >= MAX_RECOVERY_BUFFERED_MESSAGES) {
    const dropped = this.recoveryBufferedMessages.shift();
    if (dropped) {
      this.removePendingDeliveryById(dropped.deliveryId);
    }
  }

  this.recoveryBufferedMessages.push({ deliveryId, message });
  this.pendingDeliveries.push({
    deliveryId,
    messageKey: buildRuntimeMessageKey(message),
    mode: "recovery_buffer"
  });
}
```

Flush on recovery end (`cleanupGuard()` and `handleAutoCompactionEndEvent` `finally`):

```ts
private async flushRecoveryBufferedMessages(): Promise<void> {
  if (this.status === "terminated" || this.contextRecoveryInProgress || this.recoveryBufferedMessages.length === 0) {
    return;
  }

  const buffered = this.recoveryBufferedMessages.splice(0, this.recoveryBufferedMessages.length);

  for (const entry of buffered) {
    try {
      const images = toImageContent(entry.message.images);
      await this.session.steer(entry.message.text, images.length > 0 ? images : undefined);
    } catch (error) {
      this.removePendingDeliveryById(entry.deliveryId);
      this.logRuntimeError("steer_delivery", error, {
        stage: "flush_recovery_buffer",
        deliveryId: entry.deliveryId
      });
    }
  }

  await this.emitStatus();
}
```

### Expose recovery state to manager
In `runtime-types.ts`, add optional method (non-breaking):

```ts
isContextRecoveryInProgress?(): boolean;
```

In `AgentRuntime`:

```ts
isContextRecoveryInProgress(): boolean {
  return this.contextRecoveryInProgress;
}
```

---

## 2) `swarm-manager.ts`: watchdog suppression, batching, and circuit breaker

### 2.1 Add watchdog state for backoff/circuit breaker

### Before
```ts
interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
}
```

### After (planned)
```ts
interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
  consecutiveNotifications: number;
  suppressedUntilMs: number;
  circuitOpen: boolean;
}
```

Add constants:
```ts
const WATCHDOG_BATCH_WINDOW_MS = 750;
const WATCHDOG_BATCH_PREVIEW_LIMIT = 10;
const WATCHDOG_BACKOFF_BASE_MS = 15_000;
const WATCHDOG_BACKOFF_MAX_MS = 5 * 60_000;
const WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS = 3;
```

Add maps:
```ts
private readonly watchdogBatchQueueByManager = new Map<string, Set<string>>();
private readonly watchdogBatchTimersByManager = new Map<string, NodeJS.Timeout>();
```

### 2.2 Reset suppression when worker actually reports

In `sendMessage()` where worker->parent-manager report is detected, extend existing reset logic:

```ts
if (isWorkerReportToManager && watchdogTurnSeqAtDispatch !== undefined) {
  const watchdogState = this.getOrCreateWorkerWatchdogState(sender.agentId);
  if (watchdogState.turnSeq === watchdogTurnSeqAtDispatch) {
    watchdogState.reportedThisTurn = true;
    watchdogState.consecutiveNotifications = 0;
    watchdogState.suppressedUntilMs = 0;
    watchdogState.circuitOpen = false;
    this.workerWatchdogState.set(sender.agentId, watchdogState);
  }
}
```

### 2.3 Suppress watchdog during context recovery

Add runtime recovery probe:

```ts
private isRuntimeInContextRecovery(agentId: string): boolean {
  const runtime = this.runtimes.get(agentId) as (SwarmAgentRuntime & {
    isContextRecoveryInProgress?: () => boolean;
  }) | undefined;

  return Boolean(runtime?.isContextRecoveryInProgress?.());
}
```

Use this in watchdog path:

- In `handleRuntimeAgentEnd()` for worker: early return if worker runtime is currently recovering.
- In `handleIdleWorkerWatchdogTimer()`: suppress if **worker** or **parent manager** runtime is recovering.

### 2.4 Rate-limit and batch notifications

Instead of sending one verbose message per worker timer callback, enqueue worker IDs per manager and flush one batch message.

#### Before (per-worker immediate verbose send)
```ts
const watchdogMessage = `⚠️ [IDLE WORKER WATCHDOG — AUTOMATED SYSTEM CHECK]
...
Worker session file: ${descriptor.sessionFile}
...`;

await this.sendMessage(agentId, descriptor.managerId, watchdogMessage, "auto", { origin: "internal" });
await this.publishToUser(descriptor.managerId, userVisibleMessage, "system");
```

#### After (batched)
```ts
this.enqueueWatchdogForBatch(descriptor.managerId, descriptor.agentId);
```

Batch flush:
```ts
private async flushWatchdogBatch(managerId: string): Promise<void> {
  // 1) pull and clear queue
  // 2) revalidate each worker (still idle, still unreported, still owned by manager)
  // 3) apply backoff/circuit-breaker eligibility
  // 4) send ONE compact manager message + ONE compact publishToUser
  // 5) advance per-worker backoff state
}
```

Compact manager message format (bounded):

```md
⚠️ [IDLE WORKER WATCHDOG — BATCHED]

N workers went idle without reporting this turn.
Workers: `worker-a`, `worker-b`, `worker-c` (+X more)

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.
```

### 2.5 Circuit breaker/backoff logic

In timer/batch eligibility check:

```ts
if (state.circuitOpen) return;
if (Date.now() < state.suppressedUntilMs) return;
```

After successful inclusion in a sent batch:

```ts
state.consecutiveNotifications += 1;

if (state.consecutiveNotifications >= WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS) {
  state.circuitOpen = true;
  state.suppressedUntilMs = Number.MAX_SAFE_INTEGER;
} else {
  const backoffMs = Math.min(
    WATCHDOG_BACKOFF_BASE_MS * 2 ** (state.consecutiveNotifications - 1),
    WATCHDOG_BACKOFF_MAX_MS
  );
  state.suppressedUntilMs = Date.now() + backoffMs;
}
```

### 2.6 Cleanup updates

`clearWatchdogState()` should also remove worker from batch queues (and clear empty manager batch timers).

---

## 3) `swarm-tools.ts`: bounded `list_agents` output with pagination and verbose mode

### Problem
Current tool dumps full filtered descriptors, pretty-printed:

```ts
parameters: Type.Object({}),
...
text: JSON.stringify({ agents }, null, 2),
details: { agents }
```

This is unbounded and explodes context/session size with large swarms.

### Planned API (backward compatible)

```ts
parameters: Type.Object({
  verbose: Type.Optional(Type.Boolean({
    description: "Include full descriptor fields (still paginated)."
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: "Page size (default: 20)."
  })),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Page offset (default: 0)."
  })),
  includeTerminated: Type.Optional(Type.Boolean({
    description: "Include terminated/stopped_on_restart workers."
  }))
})
```

### Planned default behavior
- Always return summary counts.
- Always include manager descriptor.
- Workers returned by default = **active first** (streaming/error), then most-recent idle/stopped, paged.
- Default: `verbose=false`, `limit=20`, `offset=0`, `includeTerminated=false`.

### Planned bounded response shape

```json
{
  "summary": {
    "totalVisible": 106,
    "managers": 1,
    "workers": 105,
    "statusCounts": {
      "streaming": 2,
      "idle": 96,
      "error": 4,
      "stopped": 3,
      "terminated": 1
    }
  },
  "page": {
    "offset": 0,
    "limit": 20,
    "returned": 20,
    "hasMore": true,
    "mode": "default"
  },
  "agents": [
    {
      "agentId": "manager",
      "role": "manager",
      "status": "streaming",
      "managerId": "manager",
      "model": "openai-codex/gpt-5.3-codex",
      "cwd": "/Users/adam/repos/middleman",
      "updatedAt": "2026-03-06T..."
    }
  ],
  "hint": "Use list_agents({\"verbose\":true,\"limit\":50,\"offset\":20}) for paged full descriptors."
}
```

- `verbose=true` returns full descriptor objects for the selected page only.
- `details` should mirror this bounded object (not full registry).

---

## 4) Edge Cases to Handle

1. **Worker reports after timer fired but before batch flush**
   - Revalidate `reportedThisTurn` during batch flush before sending.

2. **Worker or manager terminated between enqueue and flush**
   - Skip stale workers/managers safely.

3. **Recovery transitions mid-flight**
   - If manager/worker enters recovery before flush, skip sending.

4. **Repeated silent failures (quota loops)**
   - Backoff + max notification count suppresses repeated spam.
   - Reset only on real worker report to parent manager.

5. **Recovery buffer overflow**
   - Enforce cap and drop oldest buffered messages; keep status accurate.

6. **Large list_agents calls with verbose=true**
   - Clamp `limit` and require pagination (`offset`) to bound output.

---

## 5) Testing Strategy

### A. Idle watchdog tests (`apps/backend/src/test/idle-worker-watchdog.test.ts`)

Add/update tests for:

1. **Batching**: multiple workers timing out in same window -> one manager runtime message.
2. **Suppression during recovery (worker recovery)**: no watchdog send.
3. **Suppression during recovery (manager recovery)**: no watchdog send.
4. **Exponential backoff**: second silent turn inside backoff window does not notify.
5. **Circuit breaker**: after N notifications, further notifications suppressed.
6. **Reset on worker report**: worker report clears suppression and allows future notifications.

### B. Context guard runtime tests (`apps/backend/src/swarm/__tests__/mid-turn-context-guard.test.ts`)

Update existing test:
- Replace expectation “steer during recovery” with “buffer during recovery; no immediate `session.steer`”.

Add tests:
1. buffered messages flush after recovery completes.
2. buffer cap drops oldest and keeps pending count coherent.

### C. `list_agents` tests (`apps/backend/src/test/swarm-tools.test.ts`)

Add tests for:
1. default summary + bounded page output.
2. active/recent ordering behavior.
3. verbose pagination returns full descriptor fields but only page slice.
4. limit clamp prevents oversized payload.

---

## 6) Risk Assessment

### Risk 1: Missing important watchdog alerts due to suppression/backoff
- **Mitigation**: reset suppression on real worker report; keep user-visible batched alert; add debug logs when circuit opens.

### Risk 2: Buffered messages replay causing post-recovery burst
- **Mitigation**: strict buffer cap + overflow drop policy + optional runtime error telemetry for dropped buffered messages.

### Risk 3: Tool behavior change for `list_agents` surprises existing manager prompts
- **Mitigation**: backward-compatible params, clear `hint` field, optional docs/archetype update to mention `verbose/limit/offset`.

### Risk 4: Race conditions across timers/batches
- **Mitigation**: retain existing `turnSeq` + token checks, and revalidate eligibility at flush time.

---

## 7) Implementation Order (recommended)

1. **`runtime-types.ts` + `agent-runtime.ts`** recovery-aware buffering and recovery-state getter.
2. **`swarm-manager.ts`** suppression checks + batching + circuit breaker.
3. **`swarm-tools.ts`** bounded `list_agents` schema + formatting.
4. **Tests** (watchdog, context guard, swarm tools).
5. Run targeted Vitest suites and then full TypeScript check.

---

## Quick acceptance criteria

- With 100+ workers idling simultaneously, manager receives **one** compact watchdog message (not 100+).
- No watchdog message is sent while target manager/worker runtime is in context recovery.
- Repeated silent worker failures trigger exponential backoff and eventually suppress per-worker watchdog noise.
- `list_agents` default output stays bounded and paginated; full descriptors require explicit `verbose` + paging.
- During `contextRecoveryInProgress`, inbound runtime messages are **buffered (not steered)** and flushed after recovery (with bounded cap).

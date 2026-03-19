# WS Stack Overflow Report

## Symptom
Backend crashed with:

- `RangeError: Maximum call stack size exceeded`
- `ws/lib/sender.js`
- `ws/lib/websocket.js`
- `apps/backend/src/ws/ws-handler.ts:1051` at `socket.send(serialized)`

This happened during/right after Cortex onboarding completion.

## Investigation summary

### 1. What `ws-handler.ts:1051` was sending
`apps/backend/src/ws/ws-handler.ts` line 1051 is the generic WebSocket send path used for all server events.
It serializes a `ServerEvent` and calls `socket.send(serialized)`.

So the crash was not tied to one special onboarding-only payload type. It was happening in the common outbound WS path.

### 2. Onboarding completion flow
In `apps/backend/src/swarm/swarm-manager.ts`, `setOnboardingStatus(..., { status: "completed" })` does this:

1. Persists onboarding state via `setOnboardingStatus()` from `onboarding-state.ts`
2. Optionally renders managed onboarding content into `shared/knowledge/common.md`
3. Calls `syncManagerPromptMode(..., { recycleIfChanged: true })`
4. If the root Cortex runtime prompt mode changed, the runtime recycle is applied immediately when safe or deferred until the manager goes idle
5. Idle transition then emits normal status/snapshot WS events

Important finding: this path does **not** recursively mutate onboarding state, and `renderOnboardingCommonKnowledge()` does **not** emit another onboarding status mutation.

### 3. Circular payload / JSON recursion check
I checked the onboarding snapshot shape in `packages/protocol/src/shared-types.ts` and `apps/backend/src/swarm/onboarding-state.ts`.

Findings:
- `captured` is a plain data object
- nested fields are simple facts (`value`, `status`, `updatedAt`)
- arrays are shallow-cloned
- no circular references are introduced by onboarding state cloning/rendering

Also, `ws-handler.ts` already calls `JSON.stringify(event)` before `socket.send(...)`.
If the payload itself were circular, the failure would have happened in `JSON.stringify`, not inside `ws/lib/sender.js` / `ws/lib/websocket.js`.

### 4. Actual failure mode
The stack points to infinite recursion inside the `ws` library send path, which is consistent with a malformed/corrupted WebSocket instance whose underlying write path points back into `WebSocket.send()`.

In other words:
- onboarding completion was only the trigger point that caused a broadcast
- the real crash surface was that the backend trusted every subscribed socket to have a valid `ws` send path
- a single malformed socket could recurse in `ws` internals and take down the process

## Root cause
The root cause was an **unguarded outbound WebSocket send path** in `apps/backend/src/ws/ws-handler.ts`.

`WsHandler.send()` assumed the subscribed `ws` client instance was internally sane and called `socket.send(serialized)` directly.
If a subscribed socket had a malformed/self-referential underlying send path, the call could recurse inside `ws` (`websocket.js` <-> `sender.js`) and crash the backend.

## Fix
Updated `apps/backend/src/ws/ws-handler.ts` to:

1. **Validate socket send-path integrity before sending**
   - reject sockets with no underlying raw socket
   - reject sockets with no underlying `write()`
   - reject self-referential sockets
   - reject sockets whose raw `write()` is the same function as `WebSocket.send()`

2. **Wrap `socket.send(...)` in error handling**
   - catch synchronous send failures (including `RangeError`)
   - handle async send callback errors

3. **Drop bad sockets safely**
   - remove from subscription tracking
   - `terminate()` the bad socket so one broken client cannot crash the server

## Tests added
Added `apps/backend/src/test/ws-handler.test.ts` covering:

- malformed self-recursive socket send paths are dropped before `ws` send is called
- synchronous send failures are caught and do not crash the process

## Validation run
Passed:

- `cd apps/backend && pnpm exec vitest run src/test/ws-handler.test.ts src/test/ws-server.test.ts -t "onboarding|WsHandler send guards"`
- `cd apps/backend && pnpm exec vitest run src/test/swarm-manager.test.ts -t "returns the root Cortex runtime to the normal prompt after onboarding completes|auto-dispatches a single Cortex onboarding greeting"`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`

## Files changed
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/test/ws-handler.test.ts`
- `WS-STACK-OVERFLOW-REPORT.md`

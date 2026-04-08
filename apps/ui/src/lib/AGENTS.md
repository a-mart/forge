# Local context for `apps/ui/src/lib`

This directory contains shared client-side infrastructure. Treat the websocket client as a layered module with a stable facade and smaller internal pieces.

## ws-client

`ManagerWsClient` is the stable facade. All state flows through it, so do not bypass it with parallel client state or direct socket ownership from feature components.

Keep the `ManagerWsState` shape stable. Any change to the state contract needs a full consumer audit across the UI.

Decomposition lives in:
- `ws-client/` for request builders, runtime constants, reducers, utilities, and helpers
- `ws-client/event-handlers/` for event-specific reducers and dispatch logic

Event handlers are grouped by domain:
- `agent`
- `session`
- `conversation`
- `config`
- `directory`
- `project-agent`
- `system`
- `terminal`

Key test:
- `apps/ui/src/lib/ws-client.test.ts`

## General

When editing ws-client behavior, keep the facade contract intact and update handler submodules in the matching domain instead of centralizing more logic in the top-level file.
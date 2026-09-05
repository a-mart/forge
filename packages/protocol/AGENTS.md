# Protocol package context

## Ownership

This package owns shared wire types, request/response contracts, event definitions, and DTOs consumed
across Forge. Add or change a contract here before updating backend, UI, Electron, or CLI consumers.
Do not maintain private copies of shared contracts in application packages.

Keep domain types in focused leaf modules under `src/` and re-export public contracts through the
package barrel. Preserve the root-barrel contract when moving or splitting modules.

## Compatibility

- Additive fields may remain within a protocol version when older consumers can safely ignore them.
- Removing fields, repurposing their meaning, or changing required behavior needs an explicit protocol
  compatibility decision and may require a version bump.
- Optional does not mean semantically unimportant. Preserve defaults and absence behavior across
  serializers, parsers, persisted history, and bootstrap/replay paths.
- Request identifiers used for optimistic reconciliation are not automatically exactly-once or
  idempotency guarantees.

## Opt-in local Builder inventory

Local Builder clients may opt into a distinct `subscribe_inventory` command. It is not a
conversation subscription and must not be treated as a compatible alias of `subscribe`.

- Wire types live in `src/builder-inventory.ts` and are re-exported through the package barrel.
- `requestId` is required and bounded. The command accepts no conversation target or options.
- The correlated `inventory_snapshot` is the complete origin baseline and the positive capability
  acknowledgement. It is not transcript data, does not select a conversation, and does not mark
  anything read.
- `inventory_pong` is transport liveness only. It is not a capability acknowledgement, a viewed
  target, or a substitute for `ready`.
- These events are transient per-socket control/inventory state. They are not recorded conversation
  events and do not participate in JSONL history or replay.
- Older servers reject the distinct command as unknown (`INVALID_COMMAND`). Clients must fail closed
  and must not recover that rejection or a timeout by sending ordinary `subscribe`.
- Collaboration-server and Remote Projects runtimes reject inventory with `INVENTORY_NOT_SUPPORTED`.
- Legacy `subscribe` and `ping` remain the conversation-view contract. Explicit conversation
  subscribe is still supported.

## Downstream validation

For every contract change, audit the relevant consumers in:

- `apps/backend/src/ws/` for parsing, handlers, routes, subscriptions, and serialization.
- `apps/ui/src/lib/` and feature components for request builders, reducers, stores, and rendering.
- `packages/cli/` when the contract is exposed through CLI commands or output.
- persisted session/history projection paths when an event can be replayed after restart.

Run the focused protocol contract test plus targeted backend and UI tests for the changed behavior.
Update fixtures on both sides of the wire rather than weakening contract assertions.

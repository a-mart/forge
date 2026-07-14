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

## Downstream validation

For every contract change, audit the relevant consumers in:

- `apps/backend/src/ws/` for parsing, handlers, routes, subscriptions, and serialization.
- `apps/ui/src/lib/` and feature components for request builders, reducers, stores, and rendering.
- `packages/cli/` when the contract is exposed through CLI commands or output.
- persisted session/history projection paths when an event can be replayed after restart.

Run the focused protocol contract test plus targeted backend and UI tests for the changed behavior.
Update fixtures on both sides of the wire rather than weakening contract assertions.

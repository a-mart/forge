# Integrated terminal backend context

## Ownership and boundaries

This directory owns per-session terminal lifecycle, PTY execution, persistence, settings, access
policy, and terminal WebSocket transport. Terminal WebSockets carry raw I/O separately from the main
application WebSocket and must remain behind short-lived authenticated tickets.

Keep `terminal-service.ts` as the service facade. Place lifecycle, runtime, persistence, access, shell
discovery, and transport details in their focused modules rather than widening the facade.

## Persistence and lifecycle invariants

- Persist terminal state as VT snapshots plus the append-only output journal. Restart restoration must
  replay journal entries after the latest snapshot without reordering or dropping output.
- A terminal belongs to one manager session. Session deletion removes terminal data through its
  dedicated cleanup path.
- Project archive suspends running profile terminals; restore can bring them back. Archive is not
  deletion and must not discard persisted terminal state.
- Archived sessions cannot create or operate terminals until restored.
- Snapshot failure must not corrupt the last valid snapshot or prevent journal-based recovery.

## Security and platform behavior

- Enforce `terminal-access-policy.ts` for lifecycle mutations and ticket issuance. UI visibility or a
  client preference is never authorization.
- Validate ticket ownership, expiry, and session scope before attaching a terminal WebSocket.
- Preserve shell discovery and process behavior across macOS/Linux and Windows ConPTY. Gate Unix-only
  signals and shell assumptions with platform checks.
- Resolve paths through Node path APIs and handle missing shells, permission failures, and terminated
  processes without crashing the backend.

## Validation

Update focused tests under `apps/backend/src/terminal/__tests__/` for the changed layer. Changes to
persistence or lifecycle should cover snapshot+journal restoration, restart, session deletion, and
archive/restore as applicable. Access changes should cover denied mutations and ticket attachment, not
only the successful path.

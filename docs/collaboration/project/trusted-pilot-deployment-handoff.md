# Trusted pilot deployment handoff

This is a point-in-time project artifact for the trusted pilot deployment track. It is not the canonical operations runbook.

For current deployment, upgrade, reverse-proxy, backup, health, and troubleshooting procedures, use [../OPERATIONS.md](../OPERATIONS.md).

## Current pilot assumptions

- Deploy one primary `forge-collaboration-server` service from this repo.
- Use a dedicated collaboration data directory or volume, not a normal Builder data directory.
- Keep the server behind HTTPS plus network controls, or behind a trusted VPN/Tailscale boundary.
- Configure the initial admin with `FORGE_ADMIN_EMAIL` and `FORGE_ADMIN_PASSWORD` on first boot.
- Configure provider auth from Collaboration settings on the selected collaboration backend.
- Use the optional secondary compose service only for local multi-backend UI validation, not for a single-server pilot.

## Handoff notes retained for project tracking

- The pilot scope is trusted users only, not broad public self-hosting.
- Operators should validate `/api/health` for liveness and `/api/collaboration/status` for collaboration readiness.
- WebSocket reverse proxies need explicit tunnel/read timeouts; health polling does not keep WebSocket tunnels alive.
- Backups must include the collaboration SQLite database, auth secret, provider auth/secrets, `_collaboration` profile data, shared specialists, and skill directories.

Historical command snippets were removed from this tracker artifact to avoid diverging from the canonical runbook.

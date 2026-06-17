# Collaboration

Collaboration mode is implemented in this Forge repo. This directory is the starting point for coding agents and operators working on the current collaboration server, UI, protocol, Docker Compose path, and project tracker.

## Start here by task

| Task | Read |
|------|------|
| Understand the system design or find code paths | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Deploy, upgrade, back up, or troubleshoot a collaboration server | [OPERATIONS.md](OPERATIONS.md) |
| Change collaboration code, protocol, data model, specialists, or skills | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Check current work tracking, decisions, risks, and backlog | [project/README.md](project/README.md) |

## Current shape

Collaboration mode reuses Forge's session/runtime infrastructure but runs under the `collaboration-server` runtime target. Channels are backed by manager sessions under the hidden `_collaboration` system profile, and the collaboration UI connects to one or more collaboration backends from the Builder app.

The deployable server is built from this repo with `Dockerfile` and `docker-compose.yml`. The compose service is `forge-collaboration-server`, listens inside the container on `47287`, and is published on host port `47387` by default. The container sets `FORGE_RUNTIME_TARGET=collaboration-server` and stores data under `/var/lib/forge`.

## Storage boundary

Use a dedicated collaboration data directory or volume. Do not reuse a normal Builder `~/.forge` data directory for a collaboration server.

Structured collaboration state lives in SQLite at:

```text
${FORGE_DATA_DIR}/shared/config/collaboration/auth.db
```

User-authored content stays file-backed in the normal Forge data tree, mainly under:

```text
${FORGE_DATA_DIR}/profiles/_collaboration/
${FORGE_DATA_DIR}/shared/specialists/
${FORGE_DATA_DIR}/agent/skills/
```

SQLite owns workspace, category, channel, member, invite, read-state, and selected specialist/skill state. Markdown prompts, reference docs, specialist definitions, and skill definitions remain files.

## Migration policy summary

Collaboration SQLite migrations run at startup. They must be additive when possible, transactional, idempotent, safe to rerun, and backed up before non-trivial changes. Migrations must not delete or overwrite user-authored files. See [DEVELOPMENT.md](DEVELOPMENT.md#sqlite-migration-policy) for the coding checklist.

## Related docs

- [Configuration reference](../CONFIGURATION.md) for the broader environment variable list.
- [Project tracker](project/README.md) for current collaboration work state.
- [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md), and [Development](DEVELOPMENT.md) are the canonical current-facing collaboration docs.

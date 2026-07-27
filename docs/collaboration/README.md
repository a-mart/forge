# Collaboration

Collaboration mode is implemented in this Forge repo. This directory is the starting point for coding agents and operators working on the current collaboration server, UI, protocol, Docker Compose path, and project tracker.

## Start here by task

| Task | Read |
|------|------|
| Configure, use, secure, or troubleshoot Remote Projects | [REMOTE_PROJECTS.md](REMOTE_PROJECTS.md) |
| Understand the system design or find code paths | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Deploy, upgrade, back up, or troubleshoot a collaboration server | [OPERATIONS.md](OPERATIONS.md) |
| Change collaboration code, protocol, data model, specialists, skills, or remote origins | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Check current work tracking, decisions, risks, and backlog | [project/README.md](project/README.md) |

## Current shape

The `collaboration-server` runtime hosts two distinct product surfaces:

- **Collaboration channels** are backed by manager sessions under the hidden `_collaboration` system profile and open in the Collaboration surface.
- **Remote Projects** are normal Builder profiles and sessions stored and executed on that server. When both server policy and a browser connection preference are enabled, they appear beside local projects in the unified Builder sidebar. They are not channels or a third mode, and Forge does not clone or synchronize them locally.

See [REMOTE_PROJECTS.md](REMOTE_PROJECTS.md) for the two controls, operator API setup, supported surfaces, trusted-operator access model, session/cookie behavior, persistence, and current live-revocation limitations. Forge Desktop's Automatic Browser Host is local—not a Skill or active-origin surface—and its embedded views, optional Chrome relay, private target affinity, authority, and IPC are never forwarded into either Remote Projects or Collaboration channels.

The deployable server is built from this repo with `Dockerfile` and `docker-compose.yml`. The compose service is `forge-collaboration-server`, listens inside the container on `47287`, and is published on host port `47387` by default. The container sets `FORGE_RUNTIME_TARGET=collaboration-server` and stores data under `/var/lib/forge`.

## Storage boundary

Use a dedicated collaboration data directory or volume. Do not reuse a normal Builder `~/.forge` data directory for a collaboration server.

Structured collaboration state lives in SQLite at:

```text
${FORGE_DATA_DIR}/shared/config/collaboration/auth.db
```

Remote Projects policy and normal remote Builder profiles/sessions also stay on the server:

```text
${FORGE_DATA_DIR}/shared/config/remote-build-settings.json
${FORGE_DATA_DIR}/profiles/<profileId>/sessions/
${FORGE_DATA_DIR}/swarm/agents.json
```

User-authored Collaboration content stays file-backed in the normal Forge data tree, mainly under:

```text
${FORGE_DATA_DIR}/profiles/_collaboration/
${FORGE_DATA_DIR}/swarm/agents.json
${FORGE_DATA_DIR}/shared/specialists/
${FORGE_DATA_DIR}/skills/
${FORGE_DATA_DIR}/profiles/<profileId>/pi/skills/
${FORGE_DATA_DIR}/agent/skills/
${FORGE_DATA_DIR}/agent/manager/skills/
```

SQLite owns structured collaboration domain state: workspace, category, channel, member, invite, read-state, and selected specialist/skill state. Forge profile/session descriptors are not in that database. The `_collaboration` profile/root descriptors and channel backing manager descriptors remain in `${FORGE_DATA_DIR}/swarm/agents.json`; losing that file can orphan SQLite channel rows because `backingSessionAgentId` must resolve to a valid collaboration manager descriptor.

Markdown prompts, reference docs, specialist definitions, Forge skill definitions, and Pi agent skill definitions remain files. User-created global Forge skills live under `${FORGE_DATA_DIR}/skills/`; Pi-discovered agent skill locations live under `${FORGE_DATA_DIR}/agent/skills/` and `${FORGE_DATA_DIR}/agent/manager/skills/`.

## Migration policy summary

Collaboration SQLite migrations run at startup. They must be additive when possible, transactional, idempotent, safe to rerun, and backed up before non-trivial changes. Migrations must not delete or overwrite user-authored files. See [DEVELOPMENT.md](DEVELOPMENT.md#sqlite-migration-policy) for the coding checklist.

## Related docs

- [Configuration reference](../CONFIGURATION.md) for the broader environment variable list.
- [Project tracker](project/README.md) for current collaboration work state.
- [Remote Projects](REMOTE_PROJECTS.md), [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md), and [Development](DEVELOPMENT.md) are the canonical current-facing collaboration docs.

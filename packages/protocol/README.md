# Forge protocol

`@forge/protocol` is the shared contract package for Forge's backend, UI, Electron app, CLI, and collaboration transport. It owns wire DTOs, event definitions, request/response contracts, and shared catalog types.

## Development

```bash
cd packages/protocol
pnpm exec vitest run src/path/to/test.ts
```

Read [`AGENTS.md`](AGENTS.md) before changing an exported type. A protocol change must update its producer, parser, consumer, persistence/replay behavior, and relevant tests in the same change. Avoid duplicating DTOs in an application package.

Model catalog definitions live in [`src/model-catalog-data.ts`](src/model-catalog-data.ts); public types live in [`src/model-catalog-types.ts`](src/model-catalog-types.ts). The maintainer workflow is in [Adding Models](../../docs/ADDING_MODELS.md).

Opt-in local Builder inventory types live in [`src/builder-inventory.ts`](src/builder-inventory.ts). `subscribe_inventory` requires a bounded `requestId` and is not a conversation `subscribe`. The correlated `inventory_snapshot` is the origin baseline and the positive capability acknowledgement; `inventory_pong` is liveness only. Older servers reject the command with `INVALID_COMMAND`; clients must not fall back to `subscribe`. Collaboration-server and Remote Projects runtimes reject it with `INVENTORY_NOT_SUPPORTED`. Legacy `subscribe` and `ping` are unchanged.

For repository setup and validation tiers, see the root [README](../../README.md) and [Quality guide](../../docs/QUALITY.md).

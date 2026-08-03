# Forge protocol

`@forge/protocol` is the shared contract package for Forge's backend, UI, Electron app, CLI, and collaboration transport. It owns wire DTOs, event definitions, request/response contracts, and shared catalog types.

## Development

```bash
cd packages/protocol
pnpm exec vitest run src/path/to/test.ts
```

Read [`AGENTS.md`](AGENTS.md) before changing an exported type. A protocol change must update its producer, parser, consumer, persistence/replay behavior, and relevant tests in the same change. Avoid duplicating DTOs in an application package.

Model catalog definitions live in [`src/model-catalog-data.ts`](src/model-catalog-data.ts); public types live in [`src/model-catalog-types.ts`](src/model-catalog-types.ts). The maintainer workflow is in [Adding Models](../../docs/ADDING_MODELS.md).

For repository setup and validation tiers, see the root [README](../../README.md) and [Quality guide](../../docs/QUALITY.md).

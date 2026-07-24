# Forge External Chrome extension

This workspace owns the browser-only MV3 shell, versioned payload, public assets, identity verification, deterministic packaging, and isolated extension tests.

The M1 foundation intentionally contains no manifest or executable extension logic. Later implementation must consume the shared contracts from `@forge/protocol`, remain independently authored, and must not add native-host, Desktop registration, backend, or product UI behavior here.

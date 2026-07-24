# Forge External Chrome native messaging host

This workspace owns the narrow native-messaging framing, origin/authentication checks, authenticated local relay client, deterministic SEA packaging, and isolated host tests.

The M1 foundation intentionally contains no executable host or relay logic. Later implementation must consume the shared contracts from `@forge/protocol` and must not add browser automation, Desktop registration, backend, or product UI behavior here.

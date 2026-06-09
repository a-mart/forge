# Collaboration decisions

## Main repo is authoritative

Current collaboration backend, UI, protocol, Docker Compose, and project-tracking work uses `/Users/adam/repos/middleman` as the source of truth.

The separate `/Users/adam/repos/forge-collab` repo is stale. Do not use it for current development, Docker commands, or project tracking unless a task explicitly asks for historical comparison.

## Local two-instance Compose setup

The main repo `docker-compose.yml` defines the primary local collaboration server and an optional secondary server for multi-backend testing:

- Primary: `127.0.0.1:47387`, data in `./.forge-collaboration-data`.
- Secondary: `127.0.0.1:47388`, `multi-backend-test` profile, data in `./.forge-collaboration-data-secondary`, distinct auth cookie name.

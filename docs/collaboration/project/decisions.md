# Collaboration decisions

## Current repo is authoritative

Current collaboration backend, UI, protocol, Docker Compose, and project-tracking work lives in this repo. Use [../README.md](../README.md) as the current documentation entry point.

## Local two-instance Compose setup

The repo `docker-compose.yml` defines the primary local collaboration server and an optional secondary server for multi-backend testing:

- Primary: `127.0.0.1:47387`, data in `./.forge-collaboration-data`.
- Secondary: `127.0.0.1:47388`, `multi-backend-test` profile, data in `./.forge-collaboration-data-secondary`, distinct auth cookie name.

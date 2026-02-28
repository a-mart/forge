# Middleman Project Documentation

Internal documentation for the radopsai fork of [Middleman](https://github.com/SawyerHood/middleman) — a local-first multi-agent orchestration platform.

## Documents

| Document | Audience | Description |
|----------|----------|-------------|
| [Self-Improvement](SELF_IMPROVEMENT.md) | Dev / AI | **Start here.** How the manager learns, memory system, meta-worker patterns, boundary analysis |
| [Architecture](ARCHITECTURE.md) | Dev / AI | System overview, component relationships, data flow diagrams |
| [User Guide](USER_GUIDE.md) | User | Setup, daily usage, workflows, and common operations |
| [Configuration](CONFIGURATION.md) | User / Dev | Environment variables, data directories, storage layout |
| [Integrations](INTEGRATIONS.md) | User | Slack and Telegram setup, configuration, and troubleshooting |
| [Customization](CUSTOMIZATION.md) | User / Dev | Skills, archetypes, extending the system |
| [API Reference](API_REFERENCE.md) | Dev / AI | WebSocket protocol, HTTP endpoints, shared types |
| [Developer Guide](DEVELOPER_GUIDE.md) | Dev / AI | Where to make changes, patterns, key files, conventions |
| [Git Setup](GIT_SETUP.md) | Dev | Remote configuration and upstream sync workflow |

## Quick Reference

- **Package manager:** pnpm 10.30.1
- **Node version:** 22+
- **Dev ports:** Backend WS `47187`, UI `47188`
- **Prod ports:** Backend WS `47287`, UI `47289`
- **Data directory:** `~/.middleman`
- **License:** Apache-2.0

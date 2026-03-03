# OSS Readiness Checklist

Audit date: 2026-02-23
Branch: `oss-readiness-audit`

### Ready ✅
- [x] No committed real `.env` files found. Only [`.env.example`](../.env.example) is tracked (`git ls-files '.env*'` => `.env.example`).
- [x] No obvious hardcoded Slack/Telegram tokens or channel IDs in integration code (`apps/backend/src/integrations/*` scan).
- [x] No frontend API keys/tokens hardcoded in app source; only expected defaults/placeholders/help URLs (for example [index.tsx:47](../apps/ui/src/routes/index.tsx#L47)).
- [x] Manager system prompt appears free of personal/private data ([manager.md](../apps/backend/src/swarm/archetypes/builtins/manager.md)).
- [x] Build succeeds: `pnpm build` passed on 2026-02-23 (warnings only).

### Needs Work 🔧
- **Legal**
- [ ] Add a root `LICENSE` file (none exists today).
- [ ] Add `license`, `repository`, `description`, `homepage`/`bugs` metadata to package manifests:
  - [package.json:1-24](../package.json#L1)
  - [apps/backend/package.json:1-35](../apps/backend/package.json#L1)
  - [apps/ui/package.json:1-55](../apps/ui/package.json#L1)
- [ ] Add contributor governance docs:
  - `CONTRIBUTING.md` (missing)
  - `CODE_OF_CONDUCT.md` (missing)
- [ ] Decide and document contributor attestation policy (CLA/DCO) before public contributions.

- **Security**
- [ ] Remove tracked runtime/session data from git and stop tracking it:
  - [data/swarm/agents.json:10-16](../data/swarm/agents.json#L10) contains absolute local paths
  - [data/sessions/manager.jsonl:1-20](../data/sessions/manager.jsonl#L1) contains conversation/runtime logs
  - [data/sessions/prod-script-worker.jsonl:1-15](../data/sessions/prod-script-worker.jsonl#L1) contains task transcript data
- [ ] Add ignore rules for runtime/state output in [`.gitignore:1-7`](../.gitignore#L1) (currently does not ignore `data/` or `*.jsonl`).
- [ ] Expand env ignore coverage at root (currently only `.env` is ignored): add `.env.*` with exceptions for examples.
- [ ] Sanitize personal path references before OSS release:
  - [AGENTS.md:15](../AGENTS.md#L15) includes `/Users/sawyerhood/...`
  - tracked `data/*` files include `/Users/sawyerhood/...` paths.
- [ ] History cleanup is likely required before OSS release: sensitive runtime logs are already in commits (`18d4c1b`, `26eba57`, `9282b21`, `063205e` touched `data/*`). Plan a history rewrite + force-push strategy.
- [ ] Add `SECURITY.md` with vulnerability disclosure process (missing).
- [ ] Add automated secret scanning (for example gitleaks in CI); local check shows `gitleaks` not installed.

- **Documentation**
- [ ] Update README for public cloning/install:
  - [README.md:53](../README.md#L53) still uses placeholder `git clone <your-repo-url> swarm`
- [ ] Add OSS-facing sections to README (or linked docs): license, security reporting, contribution workflow (currently absent from [README.md](../README.md)).
- [ ] Fix internal/private references and stale guidance in agent docs:
  - [AGENTS.md:4](../AGENTS.md#L4) references `terry-local`
  - [AGENTS.md:13-18](../AGENTS.md#L13) references Terragon/private local path
  - [AGENTS.md:59-63](../AGENTS.md#L59) documents ports that differ from repo README/runtime defaults
- [ ] Refresh stale/generated docs in `docs/`:
  - [docs/codebase-overview.md:3](../docs/codebase-overview.md#L3) says last updated `2025-02-20`
  - [docs/codebase-overview.md:555-556](../docs/codebase-overview.md#L555) lists outdated dependency versions
  - [docs/codebase-overview.md:599](../docs/codebase-overview.md#L599) shows outdated `prod` command
- [ ] Replace or remove scaffold boilerplate in [apps/ui/README.md:1-120](../apps/ui/README.md#L1) (generic TanStack starter docs are not project-accurate).
- [ ] Decide whether `docs/plans/*` should be public; several files are internal planning notes and include local-path assumptions (for example [docs/plans/codex-integration.md:17](../docs/plans/codex-integration.md#L17)).

- **Code Quality**
- [ ] Fix failing tests before OSS launch. Current status from `pnpm test` (2026-02-23):
  - 52 failed / 119 total
  - failing suites include `apps/backend/src/test/swarm-manager.test.ts` and `apps/backend/src/test/ws-server.test.ts`
- [ ] Add CI/CD (GitHub Actions) for build/test/typecheck; no `.github/workflows/*` found.
- [ ] Define and document a root typecheck command. `pnpm exec tsc --noEmit` at repo root currently has no project config and exits with help text.

- **Configuration**
- [ ] Remove repo-committed operational state and rely on `SWARM_DATA_DIR` runtime storage only (current tracked `data/*` conflicts with local-first runtime boundaries). Note: the data directory has been restructured to a hierarchical profile-scoped layout under `~/.middleman/profiles/` with shared resources under `~/.middleman/shared/`.
- [ ] Revisit default UI manager ID for neutral OSS defaults:
  - [apps/ui/src/routes/index.tsx:48](../apps/ui/src/routes/index.tsx#L48) hardcodes `opus-manager`
  - backend default manager ID is `manager` ([apps/backend/src/config.ts:57](../apps/backend/src/config.ts#L57))
- [ ] Keep documenting and validating cwd policy assumptions (`~/worktrees` allowlist in [apps/backend/src/config.ts:52-55](../apps/backend/src/config.ts#L52)) for non-local contributor environments.

- **Branding/Identity**
- [ ] Unify naming across repo artifacts:
  - Public identity in README is “Middleman” ([README.md:1](../README.md#L1))
  - Agent guidance doc still brands as “terry-local” and Terragon-derived ([AGENTS.md:4](../AGENTS.md#L4), [AGENTS.md:13](../AGENTS.md#L13))
- [ ] Add concise public descriptions to package manifests (currently none in root/backend/ui package files).

### Nice to Have 🎯
- [ ] Add release badges and quick architecture diagram links in README for first-time evaluators.
- [ ] Add a pre-release script/checklist command (license present, docs present, tests green, secret scan clean).
- [ ] Add CODEOWNERS and Dependabot/Renovate config for open-source maintenance hygiene.
- [ ] Add a minimal “Maintainer workflow” doc (branching, releases, triage labels, security response SLA).

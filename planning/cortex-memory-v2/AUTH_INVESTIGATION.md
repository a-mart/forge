# Cortex Memory v2 — Isolated Env Auth Investigation

## Scope checked
- Data-dir resolution + auth path wiring in backend boot/runtime.
- Isolated dirs only:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate`
  - `/Users/adam/.middleman-cortex-memory-v2-fresh`
- No reads/writes to `~/.middleman`.

## Findings

### 1) The reported `No API key found for openai-codex` string is emitted when runtime cannot resolve any credential
Evidence:
- `@mariozechner/pi-coding-agent/dist/core/agent-session.js` throws:
  - `No API key found for ${this.model.provider}` when `modelRegistry.getApiKey()` returns empty and model is not seen as OAuth-authenticated.

### 2) Backend still uses **legacy auth path** for runtime-critical flows
Evidence:
- `apps/backend/src/config.ts` defines both:
  - `paths.sharedAuthFile` (`<dataDir>/shared/auth/auth.json`)
  - `paths.authFile` (`<dataDir>/auth/auth.json`, deprecated)
- Runtime/auth consumers still point at `paths.authFile`:
  - `apps/backend/src/swarm/runtime-factory.ts`
  - `apps/backend/src/swarm/swarm-manager.ts` (LLM memory merge)
  - `apps/backend/src/ws/routes/settings-routes.ts` (OAuth login write path)
  - `apps/backend/src/ws/routes/transcription-routes.ts`
- Migration code treats legacy auth as deprecated:
  - `apps/backend/src/swarm/data-migration.ts` copies legacy -> shared, then `cleanupLegacyFlatPaths()` removes `<dataDir>/auth`.

### 3) Isolated dir state explains the observed anomaly path
Redacted provider-presence check:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/auth/auth.json`: providers = `["anthropic","openai-codex"]`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/shared/auth/auth.json`: providers = `["anthropic","openai-codex"]`
- `/Users/adam/.middleman-cortex-memory-v2-fresh/auth/auth.json`: providers = `[]`
- `/Users/adam/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`: missing

Interpretation:
- The exact error is expected in the **fresh** lane as currently populated (no Codex credential).
- More importantly, code is brittle: if a copied/migrated dataset has credentials only in `shared/auth/auth.json` (valid v2 layout), runtime paths still reading legacy `auth/auth.json` can reproduce the same error.

## Root cause
Primary: runtime-critical auth reads are still wired to deprecated `paths.authFile` instead of canonical `paths.sharedAuthFile`.

Contributing operational factor in this isolated run: fresh lane currently contains no Codex credential (`auth/auth.json` is `{}` and `shared/auth/auth.json` is absent), so prompt dispatch there necessarily throws the no-key error.

## Recommended fix
1. **Make shared auth canonical everywhere in runtime path**
   - Switch all `AuthStorage.create(config.paths.authFile)` callsites in runtime/WS auth flows to `config.paths.sharedAuthFile`.
2. **Backward compatibility read fallback during transition**
   - If shared file missing, read legacy once and migrate/copy forward (then continue using shared).
   - Keep writes to shared only.
3. **Add regression coverage**
   - Test scenario: migrated/shared-only auth present, legacy auth missing -> model dispatch should authenticate successfully.
   - Test scenario: fresh/no-auth -> deterministic no-key error remains expected.
4. **Short-term operational workaround**
   - For isolated smoke requiring live model calls, use migrate lane (or seed fresh lane credentials) until code fix lands.

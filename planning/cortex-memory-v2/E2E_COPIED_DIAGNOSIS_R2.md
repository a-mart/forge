# E2E Copied-Production Runtime Diagnosis (R2)

## Scope
Read-only diagnosis from:
- `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md`
- `planning/cortex-memory-v2/E2E_MIGRATE_AUTH_DIFF.md`
- `.tmp/e2e-backend.log`
- `.tmp/e2e-copied-auth-settings-47387.json`
- `.tmp/e2e-migrate-runtime-result.json` (empty; script failure path)
- minimal backend runtime/auth code (`agent-runtime.ts`, `secrets-env-service.ts`, `config.ts`, `data-paths.ts`)

## Most likely root cause(s)
1. **Provider-specific auth failure (Anthropic) on non-Cortex profile dispatch**
   - Backend log shows deterministic failure during prompt dispatch for `middleman-project--s6`:
     - `Authentication failed for "anthropic" ... Run '/login anthropic' to re-authenticate.`
   - `agent-runtime.ts` retries once (`MAX_PROMPT_DISPATCH_ATTEMPTS=2`) and fails both attempts at `prompt_dispatch`.
   - This is not a WS transport issue; it fails before model streaming starts.

2. **"Configured" auth state is a presence check, not a validity check**
   - `.tmp/e2e-copied-auth-settings-47387.json` reports Anthropic as configured.
   - `secrets-env-service.ts` marks configured when a token string exists; it does **not** validate expiry/refresh viability.
   - So copied runtime can show green auth settings while runtime dispatch still fails.

3. **Data-dir mismatch is unlikely in this failure**
   - Backend startup logs repeatedly reference copied dir paths (`/Users/adam/.middleman-cortex-memory-v2-migrate/...`).
   - `config.ts` uses `MIDDLEMAN_DATA_DIR` directly; evidence indicates it was applied.

## Exact next experiment (single decisive test)
Run an **A/B dispatch in the same copied runtime** against `middleman-project`:

1. Create a new `middleman-project` session with model forced to **openai-codex** (`gpt-5.4` or `gpt-5.3-codex`) and send a one-line probe.
2. Create another new `middleman-project` session with **anthropic** (`claude-opus-4-6`) and send the same probe.

Expected:
- OpenAI path succeeds, Anthropic path fails with the same auth error.

If observed, root cause is confirmed as **isolated Anthropic credential invalidity/reauth requirement**, not migration runtime plumbing.

## What not to retry
- **Do not** rerun the same non-Cortex dispatch with unchanged Anthropic auth and expect a different result.
- **Do not** treat `/api/settings/auth` “configured: true” as auth health.
- **Do not** rely on Cortex-profile success as representative of non-Cortex profiles (it can use a different provider/model path).

## Notes
- `.tmp/e2e-migrate-runtime-result.json` being empty is consistent with script stdout redirection when the run failed and emitted error via stderr.

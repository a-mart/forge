# E2E Fresh Runtime Diagnosis (R2)

## Diagnosis (concise)

Most likely root cause is **model/auth mismatch plus misleading auth health signal**:

1. **The E2E harness explicitly creates managers with `model: "pi-opus"`** (`.tmp/e2e-fresh-runtime-check.mjs`), which resolves to provider **`anthropic`** (`apps/backend/src/swarm/model-presets.ts`).
2. Backend runtime failures in restart attempt are consistently anthropic-only:
   - `No API key found for anthropic`
   - `Authentication failed for "anthropic" ... Run '/login anthropic'`
   (from `.tmp/e2e-fresh-backend-attempt4-restart.log`).
3. `/api/settings/auth` showing `configured: true` is **not a validity check**. It only checks whether a token-like string exists in auth storage (see `listSettingsAuth` in `apps/backend/src/swarm/secrets-env-service.ts`), not whether OAuth credentials are usable/refreshable.

So copying shared + legacy auth files did not restore live dispatch because the active test path is anthropic, and those anthropic credentials are not usable at runtime.

---

## Exact next experiment (single decisive test)

Run the same fresh WS E2E flow, but switch one line in the harness from:

- `model: 'pi-opus'`

to:

- `model: 'pi-codex'` (or omit `model` to use default `pi-codex`)

Then run one user_message dispatch and check for assistant output token.

### Expected interpretation
- **If `pi-codex` succeeds:** failure is isolated to anthropic auth validity, not fresh runtime plumbing.
- **If `pi-codex` also fails:** investigate canonical auth file content/path used by runtime (`ensureCanonicalAuthFilePath`) and credential field compatibility.

---

## What not to retry

- Do **not** keep retrying by recopying shared/legacy auth files; that has already been tested and does not fix anthropic runtime auth.
- Do **not** use `/api/settings/auth configured=true` as proof credentials are valid for live dispatch.
- Do **not** rerun `pi-opus` dispatch loops until anthropic is re-authenticated (`/login anthropic`) or the test is switched to `pi-codex` for isolation.

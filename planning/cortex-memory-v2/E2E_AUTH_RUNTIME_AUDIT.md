# E2E Auth Runtime Audit

**Scope:** Read-only diagnosis of credential resolution and model dispatch path  
**Focus:** Explain how both "No API key found" and "Authentication failed" can appear even when `/api/settings/auth` reports providers configured  
**Date:** March 15, 2026 18:46 CDT

---

## Executive Summary

**Root Cause:** OAuth token expiry for both `anthropic` and `openai-codex` combined with an **undocumented model-resolution fallback** in `runtime-factory.ts`.

**Key Insight:** `/api/settings/auth` correctly reports that providers are **configured** (present in `auth.json`), but does not validate whether OAuth tokens are **valid/unexpired**. Runtime dispatch fails at credential validation time, triggering a fallback to the first available model in the registry — which is also expired.

---

## Evidence Chain

### 1. Auth State in Fresh Environment

```bash
$ cat ~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json | jq -c 'to_entries[] | {provider: .key, type: .value.type, expires: .value.expires}'
{"provider":"anthropic","type":"oauth","expires":1772570616258}
{"provider":"openai-codex","type":"oauth","expires":1773083312768}
```

**Expiry timestamps converted:**
- `anthropic`: March 3, 2026 14:43:36 CST — **expired 12 days ago**
- `openai-codex`: March 9, 2026 14:08:32 CDT — **expired 6 days ago**
- Current date: March 15, 2026 18:46 CDT

**Status:** Both providers are **configured** but both OAuth tokens are **expired**.

### 2. Runtime Error Sequence

From `.tmp/e2e-fresh-backend-attempt4-restart.log`:

```
[swarm] runtime:error {
  agentId: 'fresh-e2e-289615--s2',
  phase: 'prompt_dispatch',
  message: 'No API key found for anthropic.'
}

[swarm] runtime:error {
  agentId: 'fresh-e2e-289615',
  phase: 'prompt_dispatch',
  message: 'Authentication failed for "anthropic". Credentials may have expired or network is unavailable.'
}
```

**Question:** Why `anthropic` errors when the session model is `openai-codex/gpt-5.3-codex`?

### 3. Model Resolution Fallback (Undocumented)

From `apps/backend/src/swarm/runtime-factory.ts:323-331`:

```typescript
private resolveModel(modelRegistry: ModelRegistry, descriptor: AgentModelDescriptor): Model<any> | undefined {
  const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
  if (direct) return direct;

  const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
  if (fromCatalog) return fromCatalog;

  return modelRegistry.getAll()[0];  // ⚠️ UNDOCUMENTED FALLBACK
}
```

**Behavior:**
1. Tries to resolve requested model (`openai-codex/gpt-5.3-codex`)
2. If `ModelRegistry.find()` returns `undefined` (expired OAuth → auth check fails), fallback to catalog lookup
3. If catalog lookup also fails, fallback to **first model in registry** (`getAll()[0]`)
4. If `anthropic` is alphabetically first or registry-ordered first, it becomes the fallback
5. That fallback model is **also expired**, triggering secondary auth failures

### 4. Why Both Error Messages Appear

**"No API key found for {provider}"**  
Source: `pi-coding-agent/dist/core/agent-session.js:556`  
Thrown when: `modelRegistry.getApiKey()` returns empty AND model is not OAuth-authenticated

**"Authentication failed for {provider}"**  
Source: `pi-coding-agent/dist/core/agent-session.js:552`  
Thrown when: OAuth token exists but validation/refresh fails (network error, expired token, revoked credentials)

**Sequence for expired OAuth:**
1. Initial model resolution tries `openai-codex` → OAuth expired → `find()` returns `undefined`
2. Fallback to `anthropic` (first in registry)
3. Worker agents may hit "No API key found" if auth check skips OAuth path
4. Manager agents hit "Authentication failed" when OAuth refresh is attempted and fails

---

## API Settings Route vs Runtime Validation

### What `/api/settings/auth` Reports

From `apps/backend/src/ws/routes/settings-routes.ts`:

```typescript
export async function handleAuthSettingsQuery(config: SwarmConfig): Promise<AuthSettingsQueryResponse> {
  const authFilePath = await ensureCanonicalAuthFilePath(config);
  const authStorage = AuthStorage.create(authFilePath);
  const allProviders = authStorage.getProviders();
  
  return {
    configuredProviders: allProviders,
    // ...
  };
}
```

**Logic:**  
- Reads `shared/auth/auth.json`
- Calls `authStorage.getProviders()` which returns **provider keys**
- Does **not** validate OAuth token expiry
- Returns configured providers regardless of token validity

**Result:** API correctly reports `["anthropic", "openai-codex"]` even though both tokens are expired.

### What Runtime Validation Does

From `ModelRegistry.getApiKey()` flow:
1. Checks if provider has OAuth config
2. Attempts to resolve/refresh OAuth token
3. Validates expiry timestamp
4. Returns `undefined` if token expired/invalid
5. Triggers fallback in `resolveModel()`

**Gap:** Settings API checks presence, runtime checks validity.

---

## Contributing Factors

### 1. Isolated Environment Credential Staleness

The fresh test environment at `~/.middleman-cortex-memory-v2-fresh` contains **stale copied credentials** from an earlier setup phase.

**Expected state** (per `E2E_FRESH_AUTH_DIFF.md`):  
Fresh environment should have valid tokens expiring March 25, 2026.

**Actual state:**  
Tokens expired March 3 and March 9, 2026 (before current test date).

**Likely cause:**  
Credentials were copied during earlier Phase 3 testing but not refreshed when test execution was delayed.

### 2. Silent Fallback Behavior

The `modelRegistry.getAll()[0]` fallback is **not logged** at the point of substitution, making it invisible why a requested `openai-codex` model is dispatching as `anthropic`.

**Mitigation:** Add debug logging at fallback decision point.

### 3. No OAuth Expiry Pre-Flight Check

Manager/worker creation does not validate OAuth expiry before constructing runtime, leading to deferred failures during first prompt dispatch.

**Mitigation:** Add expiry validation in settings route or pre-flight check during session creation.

---

## Failure Mode Classification

| Mode | Trigger | Error Message | Observed In |
|------|---------|---------------|-------------|
| **Primary model expired** | Requested model has expired OAuth | "No API key found" or "Authentication failed" for **requested** provider | Expected if only one provider expired |
| **Fallback model also expired** | Primary fails → fallback to first registry model → that model also expired | "No API key found" or "Authentication failed" for **different** provider than requested | **This scenario** (openai-codex → anthropic fallback) |
| **No credentials at all** | Empty `auth.json` or missing file | "No API key found" for requested provider | Clean fresh environment |
| **Network/refresh failure** | Valid OAuth but refresh endpoint unreachable | "Authentication failed" with network hint | Transient connectivity issues |

**This case:** **Fallback model also expired** (Mode 2) — the most confusing scenario because error provider doesn't match requested model.

---

## Most Probable Failure Mode

**Mode 2: Cascading fallback with dual-expired OAuth**

1. Session created with model descriptor `{provider: "openai-codex", modelId: "gpt-5.3-codex"}`
2. Runtime factory attempts to resolve via `ModelRegistry.find("openai-codex", "gpt-5.3-codex")`
3. OAuth token for `openai-codex` is expired → `find()` returns `undefined`
4. Catalog lookup (`getModel()`) also returns `undefined` (not in pi-ai built-ins)
5. Fallback triggers: `modelRegistry.getAll()[0]` → returns first model in registry
6. First model is `anthropic` (alphabetical or registration order)
7. Prompt dispatch attempts to authenticate with `anthropic` OAuth
8. `anthropic` token is **also expired**
9. Error surfaces as "No API key found for anthropic" or "Authentication failed for anthropic"
10. User sees anthropic error when they requested openai-codex → confusion

**Why this is most probable:**
- Matches observed error logs (anthropic errors despite openai-codex model)
- Explains both error message variants
- Consistent with dual-expired state in `auth.json`
- Aligns with undocumented fallback code path

---

## Safest Bounded Next-Step Runtime Experiment

### Goal
Isolate whether the issue is:
1. Expired credentials (remediable by refresh/copy)
2. Fallback logic bug (requires code change)
3. Environment state corruption (requires fresh bootstrap)

### Experiment Design

**Step 1: Validate production credential state**
```bash
# Check production auth for valid unexpired tokens
jq -c 'to_entries[] | {provider: .key, type: .value.type, expires: .value.expires}' \
  ~/.middleman/shared/auth/auth.json

# Convert expires timestamp to readable date
# If any token expires > current epoch, that provider is viable
```

**Step 2: Copy known-good credentials to fresh environment**
```bash
# Backup current fresh auth
cp ~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json \
   ~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json.backup-stale

# Copy production credentials
cp ~/.middleman/shared/auth/auth.json \
   ~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json

# Verify copy
jq -c 'to_entries[] | {provider: .key, type: .value.type, expires: .value.expires}' \
  ~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json
```

**Step 3: Restart fresh environment backend and retry E2E**
```bash
# Stop any running fresh backend
pkill -f "DATA_DIR.*cortex-memory-v2-fresh"

# Restart with fresh credentials
cd apps/backend
MIDDLEMAN_DATA_DIR=~/.middleman-cortex-memory-v2-fresh \
MIDDLEMAN_PORT=47487 \
MIDDLEMAN_UI_PORT=47488 \
  pnpm start
```

**Step 4: Observe error pattern change**
- If errors **disappear** → confirms expired credentials were root cause
- If errors **persist with same provider** (anthropic) → confirms fallback logic active
- If errors **change to openai-codex** → confirms primary resolution working but openai-codex also expired in production
- If errors **new/different** → environment state issue

**Safety:**
- Read-only production state (no writes to `~/.middleman`)
- Isolated test environment only
- Reversible via backup file
- No code changes
- No schema migrations
- Execution time: < 2 minutes

**Expected Outcome:**
If production credentials are fresh (likely, since production is operational), copying them should resolve auth errors and expose whether fallback logic is ever invoked with valid credentials.

---

## Open Questions for Code Review

1. **Should `modelRegistry.getAll()[0]` fallback be removed?**  
   Current behavior silently substitutes a different model than requested, which can mask credential issues and create confusing error messages.

2. **Should model resolution log fallback decisions?**  
   Would help operators diagnose why requested model ≠ dispatched model.

3. **Should `/api/settings/auth` include OAuth expiry validation?**  
   Current response says "configured" for expired tokens; UI/users may interpret as "ready to use."

4. **Should session creation fail fast on expired OAuth?**  
   Currently defers validation to first prompt dispatch; earlier failure might improve UX.

5. **Should E2E test harness include credential expiry pre-flight check?**  
   Would catch stale test credentials before runtime errors.

---

## Files Examined (Minimal Set)

- `apps/backend/src/swarm/runtime-factory.ts` (model resolution + fallback logic)
- `apps/backend/src/swarm/auth-storage-paths.ts` (canonical auth path helper)
- `apps/backend/src/ws/routes/settings-routes.ts` (API settings auth query)
- `apps/backend/src/swarm/model-presets.ts` (preset descriptors)
- `~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json` (OAuth state)
- `.tmp/e2e-fresh-backend-attempt4-restart.log` (runtime error evidence)
- `planning/cortex-memory-v2/AUTH_INVESTIGATION.md` (prior context)
- `planning/cortex-memory-v2/E2E_FRESH_AUTH_DIFF.md` (expected vs actual state)

---

**Status:** Diagnosis complete. Handoff to execution lane for bounded credential refresh experiment.

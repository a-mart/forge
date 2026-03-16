# Auth/State Comparison: Production vs Copied Instance

**Date**: 2026-03-15  
**Scope**: Read-only comparison of auth/config state between `~/.middleman` (production) and `~/.middleman-cortex-memory-v2-migrate` (copied instance)  
**Objective**: Identify why non-Cortex profiles fail auth in copied instance while production works

---

## Key Findings

### 1. OAuth Token Divergence (openai-codex)

**Production** (`~/.middleman/shared/auth/auth.json`):
```json
"openai-codex": {
  "type": "oauth",
  "access": "eyJhbGci...[truncated]...neeWI",
  "refresh": "rt_tJCGUwjS_27roMUUSvSLQtq8tFxz2mmLDhISR-RuxLI...",
  "expires": 1773083312768,  // ~Jan 7, 2026
  "accountId": "de8be04e-325e-4b98-94ac-bfa8d8cf5fbf"
}
```

**Copied Instance** (`~/.middleman-cortex-memory-v2-migrate/shared/auth/auth.json`):
```json
"openai-codex": {
  "type": "oauth",
  "access": "eyJhbGci...[different token]...WVjtECkD_QvILwutEe3XGZzor6EeNqzyRxGtsu1RCfIkdw",
  "refresh": "rt_Q3olbkknD7zgSpigwWsy8Vx0txPPmHucAFMluYBzj5A...",
  "expires": 1774479044218,  // ~Jan 23, 2026
  "accountId": "de8be04e-325e-4b98-94ac-bfa8d8cf5fbf"
}
```

**Analysis**:
- Tokens are completely different (access, refresh)
- Copied instance token expires ~16 days LATER than production
- This indicates production tokens were refreshed AFTER the copy was made
- As of current time (~Jan 14, 2026), production token has expired but copied token is still valid for ~9 days

**Paradox**: The copied environment has a MORE valid token, yet auth fails. This suggests the issue is NOT token expiry.

---

### 2. Anthropic OAuth Tokens

**Both environments have IDENTICAL tokens**:
```json
"anthropic": {
  "type": "oauth",
  "refresh": "sk-ant-ort01-va7yk7d_FbR3jFGXj1bbGG0dlPfyNv8ze1Wm...",
  "access": "sk-ant-oat01-KULeHjA1HUnrUSFeRdlZmgR1Hyi_MffWT6PGcjSh...",
  "expires": 1772570616258  // ~Jan 1, 2026 - EXPIRED
}
```

**Analysis**:
- Anthropic tokens expired ~13 days ago
- Both environments share the same expired token
- Production must be successfully refreshing at runtime, copied instance is not

---

### 3. Shared Secrets

**Identical in both environments**:
```json
{
  "BRAVE_API_KEY": "BSAgOW3zUe3buWKttvFsqBowhmqroKG"
}
```

No divergence here.

---

### 4. Structural Differences

**Profiles**: Same set of profiles exist in both environments (`amd-migration`, `cortex`, `feature-manager`, `kit-workers-concept`, `middleman-project`, `mobile-app`, `ortho-invoice`)

**Copied environment has extra directory**:
```
.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/
```
This is likely from memory-v2 migration. Should not affect auth.

**Swarm state**:
- `.middleman/swarm/agents.json`: 1,209,222 bytes
- `.middleman-cortex-memory-v2-migrate/swarm/agents.json`: 1,141,361 bytes
- Size difference expected (production actively running)

---

## Likely Root Causes

### Primary Hypothesis: OAuth Refresh Mechanism Not Active

**Evidence**:
1. Both environments have expired Anthropic tokens (expired Jan 1)
2. Production openai-codex token is expired (Jan 7)
3. Copied openai-codex token is still valid (expires Jan 23) but represents a LATER refresh cycle

**Implication**:
- Production backend must have an active OAuth token refresh flow that runs at request-time or on startup
- When production hits an expired token, it uses the refresh token to get a new access token
- The copied instance backend may NOT be running this refresh logic, OR:
  - It's not properly configured to use the copied data directory
  - Token refresh writes are going to the wrong location
  - The backend process isn't actually pointing at `~/.middleman-cortex-memory-v2-migrate`

### Secondary Hypothesis: Data Directory Mismatch

**Scenario**: The backend process for E2E testing might be configured with:
```bash
MIDDLEMAN_DATA_DIR=~/.middleman  # Still pointing at production!
```

Instead of:
```bash
MIDDLEMAN_DATA_DIR=~/.middleman-cortex-memory-v2-migrate
```

**Symptoms this would cause**:
- Backend reads config/auth from production (which has refresh working)
- UI or test client connects to backend expecting isolated data
- Profile-specific sessions fail because backend is serving production state, not copied state
- Auth appears to "fail" because of state inconsistency, not actual token invalidity

### Tertiary Hypothesis: In-Memory Token Cache

Production backend may have refreshed tokens in memory that haven't been written to disk yet. The copied instance:
1. Has the stale on-disk tokens from when copy was made
2. Doesn't have the in-memory refreshed tokens
3. On startup, needs to refresh but either:
   - Refresh logic isn't triggered
   - Refresh writes are failing
   - Refresh is writing to wrong location

---

## Recommended Remediation Path

### Immediate Fix (Runtime Repair Lane)

1. **Copy fresh auth from production**:
   ```bash
   cp ~/.middleman/shared/auth/auth.json \
      ~/.middleman-cortex-memory-v2-migrate/shared/auth/auth.json
   ```
   This brings the copied instance in sync with production's current (presumably working) auth state.

2. **Verify backend data directory configuration**:
   Check that the backend process for isolated testing explicitly sets:
   ```bash
   export MIDDLEMAN_DATA_DIR=~/.middleman-cortex-memory-v2-migrate
   ```

3. **Restart backend** to pick up fresh auth and ensure refresh logic runs.

### Validation Steps

1. Start isolated backend with explicit data dir:
   ```bash
   MIDDLEMAN_DATA_DIR=~/.middleman-cortex-memory-v2-migrate pnpm --filter backend dev
   ```

2. Create a new non-Cortex manager session in UI (connecting to isolated backend)

3. Send a chat message that requires model dispatch (e.g., `gpt-5.3-codex` or `claude-opus-4-6`)

4. Verify auth succeeds and response streams correctly

### Longer-Term Validation Needs

- Add explicit OAuth refresh logging to backend to observe when/why refresh fails
- Consider environment-specific auth test fixtures for fully isolated E2E environments
- Document expected token refresh behavior in migration playbook

---

## Files Compared

**Auth/Config**:
- `~/.middleman/shared/auth/auth.json` ✓
- `~/.middleman-cortex-memory-v2-migrate/shared/auth/auth.json` ✓
- `~/.middleman/shared/secrets.json` ✓
- `~/.middleman-cortex-memory-v2-migrate/shared/secrets.json` ✓

**Profile Structure** (sample: feature-manager):
- Session meta.json samples ✓
- Profile-level files (memory.md, schedules, integrations) ✓

**Swarm State**:
- `~/.middleman/swarm/agents.json` (size check only)
- `~/.middleman-cortex-memory-v2-migrate/swarm/agents.json` (size check only)

**Not Inspected** (per task scope):
- Session logs/history (excluded to avoid unrelated log noise)
- Worker output files
- Telegram/integration runtime state

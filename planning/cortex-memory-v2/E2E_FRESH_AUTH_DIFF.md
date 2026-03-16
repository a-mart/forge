# E2E Fresh Auth/State Comparison

**Worker:** `cortex-memv2-e2e-fresh-auth-diff`  
**Scope:** Compare production vs fresh isolated environment auth/config state  
**Focus:** Model dispatch differences affecting assistant creation

---

## Executive Summary

**Root Cause Identified:** Production environment has an **expired OpenAI Codex OAuth token**.

- **Production token expired:** March 9, 2026 (6 days ago)
- **Fresh token expires:** March 25, 2026 (10 days from now)
- **Current date:** March 15, 2026

**Impact:** Assistant creation fails in production because the default model preset (`pi-codex` → `openai-codex`/`gpt-5.3-codex`) requires valid OAuth authentication.

---

## Detailed Comparison

### Auth Tokens

#### Production (`~/.middleman/shared/auth/auth.json`)
```json
{
  "openai-codex": {
    "type": "oauth",
    "expires": 1773083312,  // March 9, 2026 14:08:32 CDT — EXPIRED
    "accountId": "de8be04e-325e-4b98-94ac-bfa8d8cf5fbf"
  }
}
```

#### Fresh (`~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`)
```json
{
  "openai-codex": {
    "type": "oauth",
    "expires": 1774479342,  // March 25, 2026 17:55:42 CDT — VALID
    "accountId": "de8be04e-325e-4b98-94ac-bfa8d8cf5fbf"
  }
}
```

**Note:** Both environments share the same account ID, indicating the fresh token is simply a refreshed version of the same OAuth session.

### Anthropic Tokens

Both environments have **identical** Anthropic OAuth tokens (same refresh/access/expires values). No difference here.

### Other State Differences

| File/Dir | Production | Fresh | Impact |
|----------|-----------|-------|--------|
| `shared/secrets.json` | Present (Brave API key) | Missing | Low — not used for model dispatch |
| `shared/mobile-*.json` | Present | Missing | None — UI-only config |
| `shared/slash-commands.json` | Present | Missing | None — not related to auth |
| `swarm/agents.json` | 1,783 agents | 3 agents | None — registry size doesn't affect auth |
| Profile dirs | Multiple profiles | Only `cortex` | None — isolated test scope |

---

## Model Resolution Flow

From `apps/backend/src/swarm/model-presets.ts`:

```typescript
export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

const MODEL_PRESET_DESCRIPTORS = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh"
  }
};
```

When no explicit model is specified (as in fresh environment session with `modelId: null`), the system falls back to the default preset, which requires a valid `openai-codex` OAuth token.

---

## Fix Strategy

**Recommended Action:** Copy the fresh (valid) OpenAI Codex OAuth credentials from the isolated environment to production.

**Implementation:**
1. Extract `openai-codex` section from `~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`
2. Replace corresponding section in `~/.middleman/shared/auth/auth.json`
3. Preserve other auth sections (Anthropic) unchanged
4. Verify token expiry timestamp is in the future
5. Test assistant creation in production

**Safety:** Low risk — both tokens belong to the same OAuth account; we're only updating expired credentials with fresh ones.

---

## Files Examined

- `~/.middleman/shared/auth/auth.json`
- `~/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json`
- `~/.middleman/shared/secrets.json`
- `~/.middleman/swarm/agents.json`
- `~/.middleman-cortex-memory-v2-fresh/swarm/agents.json`
- `apps/backend/src/swarm/model-presets.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/runtime-factory.ts`

---

## Next Steps (for runtime repair lane)

1. **Backup production auth:** `cp ~/.middleman/shared/auth/auth.json ~/.middleman/shared/auth/auth.json.backup-$(date +%s)`
2. **Extract fresh token:** Read `openai-codex` section from fresh environment
3. **Update production:** Merge fresh token into production auth.json (preserve Anthropic section)
4. **Verify:** Check that `jq '.["openai-codex"].expires' ~/.middleman/shared/auth/auth.json` shows future timestamp
5. **Test:** Attempt assistant creation in production environment
6. **Monitor:** Check backend logs for successful OAuth flow

---

**Status:** Analysis complete. Handoff to runtime repair lane for remediation.

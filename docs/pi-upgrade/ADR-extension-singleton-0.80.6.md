# ADR: Pi 0.80.6 extension ecosystem compatibility (singleton preservation)

- **Status:** Accepted (pre-pin spike)
- **Date:** 2026-07-11
- **Deciders:** Pi upgrade implementation (safety harness + WP-2 spike)
- **Related plan:** `.internal/pi-0.80.6-upgrade-plan.md` §7

## Chosen policy (authoritative)

**Breaking migration with diagnostics. No Forge-owned `@mariozechner/*` re-export shim packages.**

Reason: target `0.80.6` coding-agent extension loading uses jiti/virtual-module aliases that map legacy `@mariozechner/pi-*` specifiers directly to `@earendil-works` entrypoints. A Forge workspace package named `@mariozechner/pi-ai` (etc.) would not be the executing resolution path for extensions loaded through Pi’s loader without fragile loader patches. Forge therefore will not ship temporary shim packages for this upgrade.

Incidental upstream loader aliases may still resolve some old-specifier imports inside Pi’s loader; that is **not** a Forge compatibility product contract and must not be documented as shim support.

## Plan option-letter map (to avoid nomenclature confusion)

In `.internal/pi-0.80.6-upgrade-plan.md` §7 the letters are:

| Plan letter | Meaning |
|---|---|
| **Option A** | Breaking migration with diagnostics |
| **Option B** | Temporary Forge-owned re-export-only shims (only if spike proves Forge owns resolution) |
| **Option C** | Package-manager alias / vendored second copy (**rejected**) |

**Accepted: plan Option A.**  
**Rejected: plan Option B and Option C.**

If any earlier verbal report swapped the letters, the **policy text above wins**: breaking migration / no Forge shims.

## Context

User/project Pi extensions may import legacy `@mariozechner/*` specifiers after the package-scope move to `@earendil-works/*`. Forge must preserve a single Pi AI module graph (registry, Codex WS cache, types) in source and packaged Electron. Plan Option B (Forge-owned re-export shims) is only allowed if the spike proves Forge shims are the actual extension resolution path without fragile loader patches.

## Spike evidence (pre-pin; no dependency changes)

### 1. Target loader legacy aliases (0.80.6 tarball)

Inspected `@earendil-works/pi-coding-agent@0.80.6` (`dist/core/extensions/loader.js`, SHA-256 matches plan):

- In Node/dev mode, jiti `alias` maps **both** `@mariozechner/pi-*` and `@earendil-works/pi-*` to the **same** resolved `@earendil-works` entrypoints via `import.meta.resolve` / workspace paths.
- `@mariozechner/pi-ai` and `@mariozechner/pi-ai/compat` both alias to `@earendil-works/pi-ai/compat`.
- Bun binary mode uses in-loader `virtualModules` with the same mapping.

Therefore a Forge workspace package named `@mariozechner/pi-ai` would **not** be consulted by the extension loader: jiti aliases bypass Node’s package-name resolution for those specifiers.

### 2. Source singleton on current 0.71.1 family

On this branch (patched 0.71.1), Forge-parent and coding-agent-parent resolution of `@mariozechner/pi-ai` share one realpath and identical state-bearing exports (`registerFauxProvider`, `getModel`, `closeOpenAICodexWebSocketSessions`).

### 3. Electron split risk (characterization)

`BACKEND_BUNDLE_EXTERNAL_PACKAGES` externalizes `@mariozechner/pi-coding-agent` but **not** `@mariozechner/pi-ai`. Staging walks coding-agent’s closure (including `pi-ai`), so packaged Electron can still host a bundled Forge-side `pi-ai` plus a staged transitive `pi-ai`. This is documented by `scripts/__tests__/packaged-runtime-pi-singleton-characterization.test.mjs` and remains a WP-9 fix after pins — not a reason to ship plan Option B shims.

## Decision table

| Option (plan §7) | Decision |
|---|---|
| **A. Breaking migration + diagnostics** | **Accepted** |
| **B. Temporary Forge re-export shims** | **Rejected** — loader aliases bypass shims; proving shim ownership would require fragile loader patches |
| **C. Package-manager alias / vendored second copy** | Rejected (split graph) |

## Consequences

1. Do **not** add `@mariozechner/pi-*` shim packages for `0.80.6`.
2. Ship path-specific `ERR_MODULE_NOT_FOUND` diagnostics, local scanner/codemod, and migration notes (WP-10) so extensions rewrite to `@earendil-works/*` (legacy root → `/compat` where required).
3. Do not document Forge-owned shim support. Upstream loader aliases are incidental only.
4. Electron must externalize/stage the entire `@earendil-works/pi-ai` subpath closure after pins (WP-9) so Forge and coding-agent share one implementation.

## Shim expiry

Not applicable (no Forge shims; plan Option A). No shim removal calendar.

## Follow-up verification after atomic pins

Still required before merge: real old-specifier extension load through `DefaultResourceLoader + createAgentSession` on `0.80.6` (expect upstream alias success or Forge diagnostic), packaged Electron singleton/WS identity, and unsupported-subpath diagnostics. Those gates do not reopen plan Option B unless new evidence shows Forge can own resolution without patching upstream `getAliases()`.

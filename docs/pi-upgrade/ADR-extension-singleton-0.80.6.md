# ADR: Pi 0.80.6 extension ecosystem compatibility (singleton preservation)

- **Status:** Accepted (pre-pin spike)
- **Date:** 2026-07-11
- **Deciders:** Pi upgrade implementation (safety harness + extension/singleton spike)
- **Related plan:** `.internal/pi-0.80.6-upgrade-plan.md` §7 (historical letter labels there are not used below)

## Decision (authoritative)

**Breaking extension migration, no shims.**

Forge will **not** ship temporary Forge-owned `@mariozechner/*` re-export shim packages for the `0.80.6` upgrade. Extensions that still import legacy `@mariozechner/pi-*` specifiers must migrate (diagnostics, scanner/codemod, and docs in WP-10). Upstream Pi loader aliases that happen to remap some old specifiers are incidental only and are **not** a Forge compatibility product contract.

## Why

Target `@earendil-works/pi-coding-agent@0.80.6` extension loading uses jiti / virtual-module aliases that map legacy `@mariozechner/pi-*` (and new `@earendil-works/pi-*`) specifiers **directly** to `@earendil-works` entrypoints. A Forge workspace package named `@mariozechner/pi-ai` (etc.) would therefore **not** be the executing resolution path for extensions loaded through Pi’s loader unless Forge patched upstream `getAliases()` (fragile; rejected).

## Alternatives considered

| Policy | Outcome |
|---|---|
| **Breaking extension migration, no shims** (diagnostics + scanner/codemod + docs) | **Accepted** |
| **Temporary Forge-owned re-export shims** (tiny packages that only re-export `@earendil-works`) | **Rejected** — jiti aliases bypass Node package-name resolution for those specifiers |
| **Package-manager alias / vendored second Pi copy** | **Rejected** — splits singleton state (registry / WS cache / types) |

## Spike evidence (pre-pin; no dependency changes)

### Target loader legacy aliases (`0.80.6` tarball)

Inspected `@earendil-works/pi-coding-agent@0.80.6` (`dist/core/extensions/loader.js`, SHA-256 matches plan):

- Node/dev: jiti `alias` maps both `@mariozechner/pi-*` and `@earendil-works/pi-*` to the same resolved `@earendil-works` entrypoints.
- `@mariozechner/pi-ai` and `@mariozechner/pi-ai/compat` both alias to `@earendil-works/pi-ai/compat`.
- Bun binary mode uses in-loader `virtualModules` with the same mapping.

### Source singleton on current `0.71.1` family

Forge-parent and coding-agent-parent resolution of `@mariozechner/pi-ai` share one realpath and identical state-bearing exports (`registerFauxProvider`, `getModel`, `closeOpenAICodexWebSocketSessions`).

### Electron split risk (characterization)

Today `BACKEND_BUNDLE_EXTERNAL_PACKAGES` externalizes `@earendil-works/pi-coding-agent` but **not** `@mariozechner/pi-ai`. That packaged split risk is WP-9 after pins; it does not justify shipping temporary shims.

## Consequences

1. Do **not** add `@mariozechner/pi-*` shim packages for `0.80.6`.
2. Ship path-specific `ERR_MODULE_NOT_FOUND` diagnostics, local scanner/codemod, and migration notes (WP-10) so extensions rewrite to `@earendil-works/*` (legacy root → `/compat` where required).
3. Do not document Forge-owned shim support.
4. After pins, Electron must externalize/stage the entire `@earendil-works/pi-ai` subpath closure (WP-9) so Forge and coding-agent share one implementation.
5. **Asset adjudication (WP-9):** target `getThemesDir` / `getExportTemplateDir` resolve package-relative under staged `node_modules/@earendil-works/pi-coding-agent`. Bundle-relative `backend/dist/modes/interactive/theme` and `backend/dist/core/export-html` duplicates are removed; packaged preflight asserts package-relative assets and rejects reintroduction of the private copies.

## Shim expiry

Not applicable — no Forge shims.

## Follow-up after atomic pins

Source + staged packaged gates now cover old-specifier / unsupported-subpath extension loads through real `DefaultResourceLoader + createAgentSession`, package-relative theme/export asset adjudication, and four-family identity/skew checks. Remaining owner gates before broad rollout: extracted macOS/Windows installer smoke, live provider canary, and copied-data downgrade rehearsal. Those gates do not reopen temporary shims unless new evidence shows Forge can own resolution without patching upstream loader aliases.

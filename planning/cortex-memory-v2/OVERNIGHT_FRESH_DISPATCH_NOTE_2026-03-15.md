# Overnight note — Fresh live-dispatch blocker tightened (2026-03-15 late)

## What was run
- Isolated fresh backend only, unique port `47687`, data dir `/Users/adam/.middleman-cortex-memory-v2-fresh`.
- One bounded baseline run with no auth file.
- One bounded rerun after single-file copy: `~/.middleman/shared/auth/auth.json` -> fresh auth path.
- Harness: `.tmp/e2e-fresh-live-dispatch-bounded.mjs` (model `pi-codex`).

## Result
- No assistant token in either run.
- Both runs failed with identical runtime signature:
  - `No API key found for openai-codex ... Message may need to be resent.`
- Backend log confirms failures happen at `prompt_dispatch` during manager bootstrap and session message send.

## Why the auth-copy workaround no longer helps
- Copied auth payload currently contains stale/expired OAuth expiries:
  - `anthropic` -> `2026-03-03T20:43:36.258Z`
  - `openai-codex` -> `2026-03-09T19:08:32.768Z`
- Therefore, copying from production into fresh reproduces stale credentials instead of enabling dispatch.

## Practical blocker statement
Fresh lane is blocked by credential validity in this runtime snapshot, not by Memory v2 plumbing.

## Minimal next fix (no redesign)
Perform provider re-login in isolated fresh env (`/login openai-codex`) and run one bounded dispatch check. If that yields a real assistant response, capture it and close `CRT-04`; otherwise keep blocker classified as auth validity.

# AUTH-03 — Production Non-Touch Evidence / Waiver Note

Date: 2026-03-15  
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Determination

**Explicit byte-identical before/after proof for `/Users/adam/.middleman` is not available in the current artifact set.**  
Therefore this is a **precise waiver** for AUTH-03, with the strongest available process/log evidence summarized below.

## Evidence that does exist (non-touch intent + isolated execution)

1. **Isolation boundary declared up front**
   - `planning/cortex-memory-v2/STATUS.md:17` — production dir explicitly marked: “Production data dir to avoid touching: `/Users/adam/.middleman`”.
   - `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md:31` — `ENV-PROD-GUARD` states production “must not be mutated”.

2. **Runtime commands pinned to isolated data dirs**
   - `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md:19,112,176` — backend runs use `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate`.
   - `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md:70,228` — backend runs use `MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh`.
   - `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md:21` — scan-delta backend run also pinned to migrate dir.

3. **Explicit non-touch statements in validation reports**
   - `planning/cortex-memory-v2/E2E_SCAN_AUDIT.md:12` — “No production writes were performed.”
   - `planning/cortex-memory-v2/E2E_SCAN_DELTAS.md:5` — “copied environment only; no writes to `~/.middleman`”.
   - `planning/cortex-memory-v2/VALIDATION_PHASE3_REPORT.md:7-10,69-70` — isolated-only scope and “No production data directory writes were performed.”

4. **Only approved cross-boundary operation documented is one-way copy _from_ production auth into fresh**
   - `planning/cortex-memory-v2/E2E_FRESH_RUNTIME.md:142-150,296` — single-file copy from `/Users/adam/.middleman/shared/auth/auth.json` to fresh isolated dir; doc explicitly says no other files were copied.

5. **Tracker/index already classify AUTH-03 as partial due to missing diff artifact**
   - `planning/cortex-memory-v2/E2E_ACTIVE_TRACKER.md:122` — AUTH-03 marked `PARTIAL`, explicitly citing no byte-identical before/after artifact.
   - `planning/cortex-memory-v2/E2E_TEST_INDEX.md:97,128` — AUTH-03 remains partial until explicit diff or waiver.
   - `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md:98,119` — same caveat carried into final synthesis.

## Why this is a waiver (not full proof)

What is missing is a dedicated **before/after filesystem fingerprint artifact** for `/Users/adam/.middleman` (e.g., manifest/hash snapshot pair proving zero byte changes across the validation window). Existing evidence is strong process discipline and path isolation, but not cryptographic before/after proof.

## AUTH-03 status

**Waived (evidence-backed, non-cryptographic):** production non-touch is supported by command/path isolation and explicit reporting, but not closed with byte-diff proof.

# Data Directory Restructure — Cutover Plan

> **Status: ✅ COMPLETED** — Merged to main and live as of 2026-03-03.
> Migration ran successfully against live data. One issue encountered during cutover: auth file path needed adjustment in the migration (shared/auth/auth.json). Resolved and verified.
> Legacy flat directories (`sessions/`, `memory/`, `schedules/`, `auth/`, `integrations/`, root `secrets.json`) have been removed. The `.migration-v1-done` sentinel is present.

**Branch:** `feat/data-directory-restructure` (11 commits, ~4,500 lines)  
**Worktree:** `/Users/adam/repos/middleman-data-restructure`  
**Live data:** `~/.middleman` (~3.8GB, ~330 agents, ~335 session files)

## What the migration does

On first boot with the new code, the migration automatically:

1. Creates `profiles/feature-manager/` and `profiles/middleman-project/` with hierarchical layout
2. Hardlinks all session JSONL files into profile-scoped paths (zero-copy, instant)
3. Copies memory files (only 15 managers — workers no longer get memory files)
4. Merges session-scoped schedule files into parent profile schedule files
5. Copies auth/secrets to `shared/auth/` and `shared/secrets.json`
6. Copies integration configs to `profiles/*/integrations/` and `shared/integrations/`
7. Rewrites `agents.json` with new hierarchical `sessionFile` paths
8. Builds `meta.json` manifest per session
9. Removes legacy flat directories (`sessions/`, `memory/`, `schedules/`, `auth/`, `integrations/`, root `secrets.json`)
10. Writes `.migration-v1-done` sentinel

Total time: <1 second (verified against real data).

---

## Pre-flight (while live system is still running)

### Step 1: Back up the live data directory

```bash
cp -a ~/.middleman ~/.middleman-backup-$(date +%Y%m%d-%H%M%S)
```

~3.8GB, ~30 seconds. This is the safety net — if anything goes wrong, restore this verbatim.

### Step 2: Verify the branch merges cleanly

```bash
cd /Users/adam/repos/middleman
git merge --no-commit --no-ff feat/data-directory-restructure
# If clean → git merge --abort (just testing)
# If conflicts → resolve before proceeding
```

The branch is based on `6964382` (current main HEAD). If main hasn't diverged, this will be a clean fast-forward.

---

## Cutover (requires brief downtime)

### Step 3: Stop the live system

```bash
# Kill the prod instance (port 47287/47289)
kill $(pgrep -f "MIDDLEMAN_PORT=47287")
# Or if using the daemon:
cd /Users/adam/repos/middleman && node scripts/prod-daemon-restart.mjs stop
```

> ⚠️ This will disconnect all active UI sessions and any running agents. Active agent streams will be interrupted but are recoverable — they normalize to idle on next boot.

### Step 4: Merge the branch

```bash
cd /Users/adam/repos/middleman
git merge feat/data-directory-restructure
pnpm install   # in case any deps changed
pnpm build
```

### Step 5: Start the new system

```bash
cd /Users/adam/repos/middleman
pnpm prod
```

The migration runs automatically on first boot (see "What the migration does" above).

### Step 6: Verify

- [ ] Open `http://127.0.0.1:47289` — UI should load with all managers/sessions
- [ ] Check `~/.middleman/profiles/` — should contain only `feature-manager/` and `middleman-project/`
- [ ] Check `~/.middleman/` — no more `sessions/`, `memory/`, `schedules/` flat dirs
- [ ] Send a test message to a manager — verify chat works
- [ ] Check `~/.middleman/.migration-v1-done` exists
- [ ] Verify memory file: `cat ~/.middleman/profiles/middleman-project/memory.md` has content

---

## Rollback

### Option A: Full rollback (restore data + revert code)

```bash
# Stop the instance
kill $(pgrep -f "MIDDLEMAN_PORT=47287")

# Restore data
rm -rf ~/.middleman
mv ~/.middleman-backup-YYYYMMDD-HHMMSS ~/.middleman

# Revert code
cd /Users/adam/repos/middleman
git reset --hard HEAD~11   # back to pre-merge commit
pnpm build
pnpm prod
```

### Option B: Restore data only (keep new code, re-run migration)

```bash
# Stop the instance
kill $(pgrep -f "MIDDLEMAN_PORT=47287")

# Restore data
rm -rf ~/.middleman
cp -a ~/.middleman-backup-YYYYMMDD-HHMMSS ~/.middleman

# Restart — migration will re-run from scratch
pnpm prod
```

---

## Post-cutover cleanup

Once satisfied everything works:

```bash
# Remove the backup (free ~3.8GB)
rm -rf ~/.middleman-backup-*

# Remove the worktree and branch
cd /Users/adam/repos/middleman
git worktree remove /Users/adam/repos/middleman-data-restructure
git branch -d feat/data-directory-restructure

# Remove test instance data (if not already cleaned by worktree removal)
rm -rf /Users/adam/repos/middleman-data-restructure
```

---

## Key safety properties

- **Backup before anything** — full copy of `~/.middleman` taken before any changes
- **Migration is idempotent** — sentinel file prevents double-run; safe to restore data and retry
- **Downtime is ~30 seconds** — merge + build + boot
- **No data loss** — hardlinks preserve original content; backup is the definitive safety net
- **Clean rollback** — restore backup + `git reset` returns to exactly the pre-cutover state
- **Verified against real data** — E2E validation script passed 35/35 checks against live data copy

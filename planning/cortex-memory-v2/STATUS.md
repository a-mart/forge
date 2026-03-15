# Cortex Memory v2 — Status

## Project Summary
Implement the full Cortex memory redesign with:
- Option A end-state
- lean injected summary memory
- pull-based reference docs
- session-memory review/bookkeeping
- migration-safe rollout for existing environments
- correct behavior for net-new environments

## Environment Isolation
- Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
- Branch: `feat/cortex-memory-v2`
- Existing-data test dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
- Net-new test dir: `/Users/adam/.middleman-cortex-memory-v2-fresh`
- Production data dir to avoid touching: `/Users/adam/.middleman`

## Execution Model
- Primary implementation: GPT-5.4 high
- Code reviews: Codex 5.3 high + Opus 4.6 high
- Remediation returns to primary implementation lane
- E2E validation: separate medium-reasoning workers

## Current Phase
- Setup complete
- Detailed implementation beginning

## Latest Completed
- Two architecture/review cycles completed
- Initial main-branch prep commit landed earlier for memory injection path slimming
- Dedicated worktree created
- Isolated migrate + fresh data dirs created
- Project tracking files created

## Next Up
1. Build detailed task breakdown
2. Start Phase 1 implementation in worktree
3. Stand up isolated test harnesses for migrate + fresh scenarios
4. Run implementation/review/test lanes

## Open User Review Gates
- None currently

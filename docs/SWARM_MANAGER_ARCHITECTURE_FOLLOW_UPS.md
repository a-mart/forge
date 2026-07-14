# SwarmManager architecture follow-ups

The July 2026 decomposition reduced `apps/backend/src/swarm/swarm-manager.ts` from an
11,455-line baseline to a sub-1,500-line composition root. Independent review and the full quality
gate found the integrated result merge-ready. The items below are intentionally deferred
architecture work, not known correctness defects or merge blockers.

Work these in separate, reviewable changes. Preserve the current public behavior and line-count
ratchets; do not reintroduce policy into `SwarmManager` to make an extraction easier.

## Recommended order

### 1. Encapsulate descriptor and profile state

**Current seam:** the live `descriptors` and `profiles` maps are still passed by reference to many
coordinators. Read policy belongs to `AgentDirectory`, while mutation and persistence policy belong
to the descriptor-store adapter, but the raw maps make those boundaries convention rather than
structure.

**Target:** keep both maps private to their owning store. Give consumers narrow read capabilities
from `AgentDirectory` and explicit live-only or durable mutation ports from the descriptor-store
adapter.

**Completion criteria:**

- application coordinators cannot mutate descriptor/profile maps or objects directly;
- archive, ordering, clone, rollback, and persistence behavior remains characterized;
- tests cover mutations that previously relied on shared object identity;
- no generic repository or service-locator abstraction is introduced.

### 2. Consolidate descriptor mutation contracts

**Current seam:** several coordinators declare overlapping local mutation interfaces. Some retain
the honest `...InLiveMaps` names while others shorten them to names that can imply durable writes.

**Target:** publish a small set of shared `Pick<DescriptorStoreAdapter, ...>` capability types with
names that state whether the operation is live-only, transactional, or durable.

**Completion criteria:**

- one definition exists for each mutation capability;
- call sites preserve durability semantics in their names and types;
- rollback and best-effort persistence tests remain at the descriptor-store boundary.

This work pairs naturally with item 1, but it should remain a separate commit or clearly isolated
phase so semantic changes are reviewable.

### 3. Replace hot-path lazy guards with a completed runtime graph

**Current seam:** the phased runtime composition uses `requireServices()` and
`requireRuntimeLifecycle()` closures to cross construction phases. They correctly fail early access,
but runtime callbacks repeatedly traverse lazy guards after composition is already complete.

**Target:** keep the explicit construction phases, then bind the completed coordinators and host
capabilities once in `complete()`. Runtime events should call stable fields rather than re-resolving
late-bound object records.

**Completion criteria:**

- early access remains impossible or fails at the composition boundary;
- completed runtime callbacks use stable bound capabilities;
- no dependency-injection framework, event bus, or dynamic proxy is added;
- runtime callback ordering and subclass runtime-factory override tests stay green.

### 4. Shrink the compatibility facade through consumer-owned interfaces

**Current seam:** `SwarmManagerFacade` intentionally preserves the broad application API, so new
capabilities can require parallel edits in an owner, the facade service map, and the delegate shell.

**Target:** migrate route, WebSocket, scheduler, and integration consumers to narrow interfaces they
own. Remove facade delegates only after every in-repository consumer has moved and the supported
public surface is explicitly accounted for.

**Completion criteria:**

- consumers request only the capabilities they use;
- the facade and its service map shrink monotonically;
- runtime-controller callbacks, mutable owner state, and test diagnostics remain private;
- no reflection-based delegate installer or compatibility layer replaces the explicit API.

## Later large-file reviews

After the four boundary items above, review the remaining production files above the preferred
1,500-line range independently. Current candidates include the Pi runtime, agent lifecycle service,
manager utilities, session audit service, specialist registry, Claude runtime, and worker-health
service.

For each candidate, first identify a cohesive state or policy owner, characterize its event order
and failure behavior, move the behavior and its state together, and delete the old path in the same
change. Raw line movement without a clearer ownership boundary is not a successful cleanup.

## Verification standard

Each follow-up should use an isolated worktree and include focused characterization for the moved
boundary, `git diff --check`, the changed-scope quality gate during development, independent review
for high-risk lifecycle/runtime changes, and `pnpm quality:full` before merge.

# Cross-Instance Cortex Collaboration Plan

## Goal
Let two separately owned Middleman/Cortex instances collaborate, compare notes, review each other’s work, and optionally coordinate tasks — while keeping each instance sovereign, auditable, and safe.

## Recommendation in one line
Build a **transport-neutral instance bridge** with **Telegram as the first adapter and human-visible meeting room**, not as the long-term core protocol.

---

## Why this is worth doing
This could enable:
- peer design/code review between Cortex instances
- question/answer across projects and environments
- knowledge-sharing without raw memory merging
- operational buddy checks before risky work
- scheduled health/status exchanges
- structured debates between two Cortexes for tricky decisions

---

## Best product shape
### User-facing concept
Think of it as **Cortex Pen Pals** or a **federation link**:
- your Cortex and your friend’s Cortex are paired
- they can talk in a dedicated Telegram group/topic
- both humans can observe the conversation
- either side can step in anytime
- no direct memory/database access across instances
- all sharing happens through explicit messages

### Recommended trust model
Use three trust tiers:
1. **Advisory only** — factual answers, suggestions, reviews
2. **Suggest and confirm** — peer proposes something, local user approves
3. **Delegated execution** — peer requests real work; local user must explicitly approve

Default should be **tier 1 only**.

---

## Telegram: good MVP, not ideal foundation
### Why Telegram is attractive
- already integrated in Middleman
- human-readable and easy to supervise
- async by nature
- good for shared rooms / group threads
- useful for bootstrapping trust and collaboration

### Why Telegram should not be the core abstraction
Current repo structure shows Telegram is built for **human chat integration**, not instance-to-instance federation.

Main gaps today:
- bot senders are explicitly ignored in `apps/backend/src/integrations/telegram/telegram-router.ts`
- there is no peer identity/authentication model
- no signed envelopes
- no ack/dedupe/replay protection
- no session-to-session peer link store
- no dedicated peer messaging tool

So: **use Telegram first, but wrap it in a proper bridge layer**.

---

## Recommended architecture

## 1) Add a transport-neutral collaboration bridge
Create a new backend service area, conceptually something like:
- `apps/backend/src/collaboration/*`
- or `apps/backend/src/integrations/bridges/*`

Responsibilities:
- local instance identity
- trusted peer registry
- session/link mapping
- outbound queue + retries + dedupe + ack handling
- audit log
- transport adapters (Telegram first, HTTP/WS later)

## 2) Add durable instance identity
Store shared instance identity outside any single profile.

Suggested fields:
- `instanceId`
- `displayName`
- `publicKey`
- timestamps
- transport hints like Telegram bot id/username

Each bridge message should be **signed**.

## 3) Add peer registry
For each trusted remote instance, store:
- peer `instanceId`
- peer public key
- approved transport route(s)
- allowed profiles/scopes
- status: pending / active / revoked

Important: trust should be bound to **signed identity**, not just a Telegram bot username.

## 4) Add session-to-session links
A collaboration link should map:
- local profile/session
- remote instance
- remote session
- transport route
- status + timestamps

This is how you keep one Telegram topic aligned with one cross-instance conversation.

## 5) Use structured envelopes, not plain text protocol
Messages between Cortex instances should be wrapped in a signed envelope.

Example envelope fields:
- version
- type: `invite`, `accept`, `message`, `ack`, `error`, `heartbeat`
- `envelopeId`
- `sentAt`
- `from`
- `to`
- transport metadata
- correlation/reply ids
- payload
- signature

Telegram can carry the envelope as encoded text, but the protocol should stay bridge-owned.

## 6) Keep peer traffic separate from normal user chat logic
Recommended inbound flow:
- Telegram router detects bridge envelope
- if bridge envelope: collaboration service handles auth/dedupe/routing
- otherwise: existing human chat flow continues unchanged

This prevents peer traffic from being mistaken for ordinary user input.

## 7) Add a dedicated peer messaging tool later
Long term, peer messages should not piggyback entirely on `speak_to_user`.

Recommended future tool concept:
- `message_peer_instance`

Why:
- cleaner semantics
- better auditability
- less confusion between user-visible chat and peer protocol traffic

---

## Telegram MVP shape
### Best setup
Use a **shared Telegram supergroup with forum topics enabled**.

Why:
- one topic per collaboration thread/link
- readable by both humans
- natural containment of discussions
- fits existing Telegram topic machinery already in repo

### MVP pairing flow
1. Each user adds their Cortex bot to a shared Telegram group
2. One side creates an invite
3. Invite is sent as a signed bridge envelope
4. Receiving side shows pending peer link
5. Human approves
6. Both sides verify a short challenge code
7. Collaboration link becomes active

### MVP capabilities
Start with:
- Q&A between Cortexes
- design review requests
- status/heartbeat messages
- knowledge suggestions for human approval

Do **not** start with automatic execution requests.

---

## Fun things the two Cortexes could do
### 1. Peer code review buddy
One Cortex sends a plan, diff, or design doc.
The other reviews it and sends back critique.

### 2. Debate mode
You ask them to argue opposite sides of a technical decision.
One defends simplicity, the other defends flexibility.
You judge the outcome.

### 3. Cross-project knowledge broker
One Cortex asks: “What’s your current understanding of session compaction handling?”
The other answers from its own learned/project knowledge.

### 4. Pre-flight safety buddy
Before a risky migration or rollout, one Cortex asks the other for a rollback sanity check.

### 5. Scheduled check-ins
Have them exchange morning or hourly summaries:
- what changed
- current blockers
- suspicious regressions
- open decisions

### 6. Teaching mode
A more mature Cortex can help onboard a newer one by answering focused questions and suggesting memory updates for approval.

### 7. Joint incident room
During a bug or outage, both Cortexes collaborate in one Telegram topic while humans watch.

---

## What should be automatic vs. manual
### Safe to automate early
- answering factual questions
- heartbeats / status pings
- logging all peer exchanges
- routing messages to the correct collaboration session
- detecting stale links / delivery failures

### Should require user approval
- memory updates based on peer suggestions
- any command execution requested by peer
- code modifications requested by peer
- widening permissions or trust scope
- linking new profiles/sessions

### Should never be automatic
- secret sharing
- direct memory/database merging
- blanket trust expansion
- unrestricted execution requests from peer

---

## Safety requirements
You absolutely want these guardrails:
- **signed peer messages**
- **trusted peer registry**
- **explicit consent model**
- **rate limiting**
- **loop detection**
- **dedupe + replay protection**
- **append-only audit log**
- **kill switch** to revoke peer access instantly

Special concern: two Cortexes can get into auto-reply loops. So add:
- max turns per time window
- pause on back-and-forth churn without human input
- visible alerts when loop prevention triggers

---

## Storage and protocol recommendations
### Suggested new state
Shared scope:
- instance identity

Profile scope:
- peer registry
- collaboration links
- bridge audit log
- outbound queue state

### Existing repo areas likely involved
Telegram/integration:
- `apps/backend/src/integrations/telegram/telegram-router.ts`
- `apps/backend/src/integrations/telegram/telegram-delivery.ts`
- `apps/backend/src/integrations/telegram/telegram-integration.ts`
- `apps/backend/src/integrations/telegram/telegram-config.ts`

Runtime/protocol:
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/swarm/conversation-validators.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `packages/protocol/src/shared-types.ts`

Storage/admin wiring:
- `apps/backend/src/swarm/data-paths.ts`
- `apps/backend/src/integrations/registry.ts`
- `apps/backend/src/ws/routes/integration-routes.ts`
- `apps/backend/src/ws/server.ts`

---

## Phased rollout
### Phase 0 — design hardening
- finalize identity/trust/envelope model
- decide bridge-first vs Telegram-only
- define consent policy

### Phase 1 — identity + peer registry
- durable instance identity
- trusted peer records
- admin APIs for invite/accept/revoke
- audit skeleton

### Phase 2 — bridge core
- queueing
- ack/dedupe/retry
- route/link model
- append-only audit

### Phase 3 — Telegram adapter MVP
- detect bridge envelopes in Telegram router
- allow trusted bot traffic only for bridge path
- send/receive structured peer messages
- map one topic to one collaboration link

### Phase 4 — UX + runtime integration
- dedicated collaboration sessions
- peer state visibility in UI
- approval flow for higher-trust actions
- better prompts/instructions for Cortex behavior

### Phase 5 — knowledge exchange + review workflows
- peer review patterns
- memory suggestion flows
- scheduled summaries / heartbeats

### Phase 6 — stronger transport
- add direct HTTP/WS bridge adapter
- keep Telegram for invites/fallback/human observability

---

## My practical recommendation
If you want the smartest path:

### V0 / first real milestone
Build a **limited Telegram-based advisory bridge**:
- trusted peer identity
- signed envelopes
- one shared group/topic per collaboration thread
- Q&A and review only
- full audit trail
- no autonomous execution

That gets you something fun and useful fast.

### Then evolve to the real version
Promote the system into a proper **instance bridge** with direct HTTP/WS as the canonical transport and Telegram as:
- pairing/bootstrap
- human-visible room
- async fallback

---

## Final take
This is a genuinely good idea.

The coolest version is **not** “two bots casually DMing each other.”
It’s:
- two sovereign Cortex instances
- explicitly linked
- human-supervised
- able to review, compare, challenge, and teach each other
- with Telegram acting as the visible social layer
- and a proper bridge layer handling trust, routing, and safety under the hood

That would be useful, novel, and very on-brand for Middleman.

# Cortex-Led Onboarding Plan — Independent Review

**Reviewer**: onboarding-plan-review-2  
**Date**: 2026-03-18  
**Verdict**: **GO WITH REVISIONS** (see Priority 1 blockers)

---

## Executive Summary

The plan is **structurally sound** and demonstrates strong alignment with the existing codebase. The core design—moving onboarding from managers to Cortex, separating user-level from project-level concerns, and using the existing knowledge flow—is the right approach.

However, the plan has **three Priority 1 blockers** that require resolution before implementation, plus several high-value refinements that would significantly improve the first-launch experience.

**Key strengths:**
- Clean separation of concerns (Cortex learns the person, managers learn the project)
- Low-churn stateful overlay approach respects existing architecture
- Realistic implementation sequencing with proper discovery integration
- Strong adaptive prompt examples that handle different user types well

**Key risks:**
- Prompt injection boundary between onboarding mode and normal Cortex behavior is underspecified
- Runtime reload gap threatens to undermine the entire user experience
- Multi-channel onboarding (Slack/Telegram) has unresolved ownership and routing complexity
- Missing fallback paths for when onboarding stalls or LLM behavior degrades

---

## Priority 1 Blockers (Must Fix)

### 1. Runtime reload is not "optional for v1" — it's a core UX requirement

**Issue**: The plan treats live runtime reload as "optional follow-up" and says:
> "accept that already-running sessions may pick up changes on next resume/runtime recreation"

**Why this is a blocker**: The entire value proposition is that the first manager **already knows** the user's defaults. But discovery found that knowledge writes are disk-immediate, not runtime-immediate. This means:

- User completes Cortex onboarding
- Cortex writes to `common.md`
- User creates first manager
- **Manager runtime loads at creation time** ✓
- First manager **DOES** see the onboarding data

Wait, that's fine. Let me reconsider...

Actually, the critical path is:
1. User finishes Cortex onboarding
2. Cortex writes `common.md`
3. User clicks "Create your first manager"
4. Backend creates manager runtime **fresh**, which loads current disk state
5. Manager sees onboarding data ✓

So for the **primary flow** (onboarding → create manager), there's no reload problem because the manager is created **after** the writes.

**The real problem** is if:
- User has an **active Cortex session running**
- User completes onboarding
- Cortex writes `common.md`
- User wants to **resume an existing paused manager** or continue chatting with **currently-running Cortex**
- Those runtimes won't see the new data

**Revised severity**: This is still concerning but not a complete blocker for the happy path. However, it creates a hidden cliff for edge cases.

**Recommendation**: 
- Document clearly that onboarding data is guaranteed visible to **newly created** managers
- Add a note that existing/paused sessions may need resume to see updates
- Consider a simple "reload injected context" signal that managers can trigger on explicit user request

### 2. Prompt activation boundary is critically underspecified

**Issue**: The plan says to inject the onboarding prompt "conditionally" when certain conditions are true, but the **deactivation transition** is vague:
> "Deactivate when: onboarding state is `completed` or `migrated`"

**What's missing**:
- How does the onboarding prompt **coexist** with the normal Cortex archetype prompt?
- Is it prepended? Appended? Completely replaces it?
- When onboarding is `completed`, does the runtime **immediately** switch prompts mid-conversation?
- What if the user is mid-turn when state transitions?
- Does prompt mode switch require a runtime restart/reload?

**Why this is a blocker**: Without clear injection/removal mechanics, implementation will be ambiguous and likely produce broken behavior. Discovery found that Cortex already has a complex operational prompt with mandatory delegation rules, review orchestration, and specific tool usage patterns. The onboarding mode needs to **coexist gracefully** or **explicitly override** that behavior.

**Current Cortex prompt says**:
> "You are Cortex — the intelligence layer of this multi-agent system. Mission: continuously review sessions..."

**Onboarding prompt says**:
> "You are meeting the human owner of this Forge installation for the first time..."

These are **contradictory identities**. One is the intelligence analyst, one is the friendly colleague getting oriented.

**Recommendation**:
- Choose one of two clear models:
  - **A. Mode-switching**: Onboarding prompt **completely replaces** Cortex archetype prompt while active; on completion, runtime is recycled with normal prompt
  - **B. Prefix injection**: Onboarding prompt is **prepended** as a conditional section, with explicit boundaries: "While onboarding is incomplete, prioritize the onboarding conversation. After completion, resume normal Cortex behavior."
- Add explicit transition behavior: when state moves to `completed`, send a system message to Cortex saying "onboarding complete, resume normal intelligence-layer duties"
- Test what happens if user manually triggers a review run while onboarding is active

### 3. Multi-channel first-launch is not "explicit product-scope decision" — it's a real operational hazard

**Issue**: The plan defers Slack/Telegram onboarding with:
> "web is the canonical first-launch onboarding surface after auth"
> "Slack/Telegram/mobile can participate later"

**Why this is problematic**: Discovery found that Forge already **auto-creates Cortex on boot** and that inbound Slack/Telegram messages already reach Cortex if routed there. This means:

1. User installs Forge
2. User configures Slack integration
3. User DMs the Slack bot before ever opening the web UI
4. Cortex receives the message
5. Onboarding prompt activates
6. **Cortex defaults to web delivery** because no explicit target is set
7. User never sees the response

This is not a "later extension" — it's an **active footgun** for non-web-first users.

**Recommendation**:
- Add explicit channel-aware routing to the onboarding prompt:
  ```md
  Important: If the user is chatting with you via Slack or Telegram (indicated by 
  sourceContext metadata in their message), you MUST use speak_to_user.target to 
  reply back to that channel. Copy channel, channelId, userId, and threadTs from 
  the inbound sourceContext.
  ```
- Add a test case: "user completes onboarding via Telegram DM, creates first manager via web"
- Update "Fresh install / auth / onboarding" test plan to cover non-web entry points

---

## Priority 2 Issues (Should Fix)

### 4. Common knowledge scope discipline is weaker than Cortex operational memory

**Issue**: The onboarding prompt examples show **high-quality user-level extraction**, but the promotion guidance is looser than current Cortex standards.

**Example from onboarding prompt**:
> "If the user expresses a preference clearly, you may treat that as sufficient confirmation."

**Compare to Cortex archetype**:
> "Strong evidence: explicit user instructions or corrections, trusted source-of-truth artifacts, explicit feedback telemetry, repeated user-side patterns"

The onboarding prompt allows **single-turn inference**, while Cortex operational rules require **strong evidence** before promotion.

**Risk**: Onboarding could pollute `common.md` with weak signals like:
- User: "I mostly work on web projects"
- Cortex promotes: "User primarily works on web projects"
- Later, user works on a backend project and gets annoying web-centric suggestions

**Recommendation**:
- Strengthen the onboarding prompt's promotion section to match Cortex evidence standards
- Add explicit language: "Onboarding is a **bootstrap**; these are initial working hypotheses. Mark entries as tentative when appropriate."
- Consider writing onboarding findings to a **separate section** in `common.md` with a clear header:
  ```md
  ## User Snapshot (from initial onboarding — update as needed)
  ```

### 5. Manager bootstrap prompt has no explicit repo inspection strategy

**Issue**: The revised manager prompt says:
> "ask for repo/directory + current goal, inspect repo files for stack/commands/conventions"

But it doesn't provide **concrete guidance** on **which files to inspect** or **how to validate findings**.

**Why this matters**: A naïve manager might:
- Read every file in the repo (explodes context)
- Infer stack from `package.json` but miss that it's actually a monorepo with multiple stacks
- Skip important convention files like `CONTRIBUTING.md`, `.github/workflows/*.yml`, or `docs/DEVELOPMENT.md`

**Recommendation**:
- Add a lightweight inspection protocol to the manager bootstrap:
  ```md
  Start by reading these in order if they exist:
  1. AGENTS.md / SWARM.md (explicit agent guidance)
  2. README.md (project overview)
  3. package.json / pyproject.toml / Cargo.toml (stack/deps)
  4. Primary build/validation commands (scripts in package.json, Makefile, etc.)
  5. CONTRIBUTING.md or docs/DEVELOPMENT.md if present
  
  Ask the user only for what you cannot infer from these files.
  ```
- This bounds the search space and gives managers a reliable starter playbook

### 6. Skip/defer state doesn't prevent re-prompting across sessions

**Issue**: The state machine shows:
- `deferred` state exists
- deferred → user wants to skip

But the activation logic says:
> "Activate when: onboarding state is `not_started`, `active`, or `deferred` with a re-entry trigger"

**What's a "re-entry trigger"?** Not defined.

**Risk**: User clicks "Skip for now" and then:
- Refreshes page → onboarding prompt fires again
- Closes Cortex tab, reopens next day → onboarding prompt fires again
- Never explicitly opts back in, but gets pestered repeatedly

**Recommendation**:
- Remove `deferred` from auto-activation
- Only activate when: `not_started` or `active`
- `deferred` requires **explicit re-entry** via:
  - UI button: "Complete onboarding with Cortex"
  - User message: "Let's do that onboarding now"
  - Manual state transition (rare)

### 7. Onboarding draft state location is unspecified

**Issue**: The plan proposes tracking structured onboarding state:
```json
{
  "status": "not_started",
  "captured": {
    "preferredName": null,
    "technicalLevel": null,
    ...
  }
}
```

**Suggested location**: `shared/onboarding-state.json`

**Problem**: Discovery showed that `shared/` already has:
- `shared/auth/auth.json`
- `shared/secrets.json`
- `shared/integrations/`
- `shared/knowledge/`

But there's no existing `shared/onboarding-*.json` or similar lightweight state file pattern. Most stateful records go into:
- agent/profile/session descriptors in `swarm/agents.json`
- per-profile directories

**Risk**: Introducing a new top-level state file could:
- Complicate backup/restore
- Be missed by data migration scripts
- Create unclear ownership (is it "user-owned" or "system-owned" data?)

**Recommendation**:
- Use `shared/knowledge/.onboarding-state.json` (hidden file alongside Cortex artifacts)
- Or store onboarding state as part of the Cortex profile: `profiles/cortex/onboarding-state.json`
- Document clearly in data-paths.ts and add to existing backup/migration logic

### 8. No fallback for when onboarding conversation stalls/degrades

**Issue**: The plan assumes a smooth conversational flow, but LLMs can:
- Refuse to progress ("I need more information")
- Loop on the same question
- Hallucinate requirements
- Fail to recognize completion criteria

**Missing**:
- Maximum turn limit before auto-completing
- User escape hatch: "I'm done, finish onboarding"
- Degraded completion: "we only got 2/5 signals, is that enough?"

**Recommendation**:
- Add a turn counter to onboarding state
- After N turns (suggest 10-12), offer explicit completion:
  ```
  We've covered quite a bit. I can work with what you've shared so far, 
  or we can keep going. Would you like to:
  - Finish onboarding now
  - Answer a few more questions
  - Skip for now and come back later
  ```
- Add a slash command: `/finish-onboarding` that forces completion

---

## Priority 3 Refinements (Nice to Have)

### 9. Onboarding completion should feel like a milestone, not a transition

**Observation**: Example conversation C shows:
> Cortex: "Absolutely. You can create your first manager now..."

This is functional but flat. First-time user experience should feel **celebratory** and **orientation-giving**.

**Suggestion**: Add a recommended completion template:
```
Great — I've got a good read on how you like to work. Here's what I learned:
- [concise 2-3 bullet summary of captured preferences]

I'll make sure future managers start with this context. When you create your 
first manager, it'll focus on the project itself rather than asking these 
questions again.

Ready to create your first manager? Click "New Manager" in the sidebar.
```

### 10. Uncertain/ambiguous signals should be explicitly flagged as tentative

**Issue**: Onboarding prompt says:
> "If something is ambiguous, keep it tentative rather than stating it as fact."

But it doesn't show **how** to mark something tentative in the output.

**Suggestion**: Add example phrasing for tentative entries:
```md
## Workflow Defaults
- **Tentative**: Prefers autonomous execution (inferred from "just get it done" 
  phrasing; confirm in early sessions)
```

### 11. The "Delegator" example workflow should move or be cut entirely

**Issue**: The current manager bootstrap includes a long "Delegator workflow" example showing git worktrees, merger agents, etc.

**Why this matters**: The plan removes this from the manager prompt, which is good. But should it appear in the Cortex onboarding prompt?

**Current onboarding prompt**: Does **not** include workflow examples.

**Observation**: This is correct. Workflow examples belong in:
- Getting Started docs
- In-app hints/tips
- Or a brief manager self-introduction

They should **not** bloat the onboarding conversation.

**Recommendation**: Confirm this is intentional and document it clearly in the plan.

### 12. Migration detection heuristic should include auth presence

**Issue**: Plan says:
> "if meaningful usage already exists, mark onboarding as `migrated`"
> Heuristics: any non-Cortex profile, `common.md` content, session history

**Missing**: Auth configuration state.

**Why it matters**: A truly fresh install has:
- No auth configured
- Empty agents store
- Seed `common.md` only

An existing install might have:
- Auth configured
- No profiles yet (user just set up auth but never created a manager)

**Is this "fresh" or "migrated"?**

**Recommendation**: Add auth presence to migration heuristic:
```
Mark as migrated if ANY of:
- Non-Cortex profiles exist
- common.md has non-seed content
- Session history exists
- Auth is configured AND (profiles exist OR common.md is non-empty)
```

This avoids forcing users who just configured auth through a pointless onboarding.

---

## Deep Dive: Dimension-by-Dimension Assessment

### 1. Prompt Quality ⭐⭐⭐⭐ (4/5)

**Strengths**:
- Genuinely adaptive: terse engineer example is crisp and respectful
- Natural colleague tone without being theatrical or salesy
- Good energy-matching guidance: "terse user → concise replies"
- Strong skip/defer behavior: honors user intent immediately
- Clear completion criteria: "enough to help" vs "perfect profile"

**Weaknesses**:
- Opens with a utilitarian explanation rather than a warm greeting
  - Current: "I can learn how you like to work so your future managers..."
  - Better: "Hey — welcome to Forge. I'm Cortex, and I help keep things running smoothly. Want to spend a minute getting oriented, or jump straight into a manager?"
- "If you want, tell me your name" feels like an afterthought in Example A
- No explicit handling for confused/uncertain users who don't know what to say
- Evidence policy is weaker than Cortex operational standards (see Priority 2 #4)

**Would it feel like meeting a smart colleague?** **Yes, mostly.** The terse engineer example is excellent. The less-technical example is supportive without being patronizing. But the opening framing is too focused on "future efficiency" and not enough on "let's get you started."

**Cringe factor?** **Low.** No forced personality, no "hey there champion!" energy, no emoji soup. The proposed tone is professional and grounded.

### 2. Manager Prompt Revision ⭐⭐⭐⭐½ (4.5/5)

**Strengths**:
- Clean separation: "Cortex handled user defaults, now focus on the project"
- Explicit anti-pattern list: what NOT to ask
- Concrete project-bootstrap items: repo, stack, commands, conventions
- Encourages repo inspection over interrogation
- Retains warm welcome while pivoting to project focus

**Weaknesses**:
- No concrete file inspection strategy (see Priority 2 #5)
- Doesn't specify what to do if injected memory is **empty** (user skipped onboarding)
- "Keep this conversational, not like a checklist" is good guidance but doesn't show an example

**Does it leverage Cortex-captured knowledge?** **Yes.** The prompt explicitly references injected memory and tells managers not to re-ask those questions.

**Is the boundary clean?** **Very clean.** The table showing what stays/removed/new is excellent.

**One gap**: What if the user skipped Cortex onboarding entirely and `common.md` is seed-only? The revised prompt says "Cortex may already have captured durable user defaults," but it should also say: "If that context is missing, focus on the project and let Cortex handle user-level preferences later."

### 3. Knowledge Flow ⭐⭐⭐⭐ (4/5)

**Strengths**:
- Clear ownership: Cortex writes `common.md`, managers write profile memory
- Sensible scope split: common (cross-profile) vs profile (project-specific)
- Incremental write strategy: update after each meaningful answer
- Runtime composition is already built and tested
- Good defaults: new managers automatically see latest disk state

**Weaknesses**:
- Runtime reload gap is **understated** in the plan (see Priority 1 #1)
- No explicit conflict-resolution strategy if Cortex and manager both try to write memory simultaneously
- Draft state persistence is proposed but not detailed enough (see Priority 2 #7)
- No mention of versioning/backup for onboarding writes

**Is the pipeline sound?** **Mostly yes.** For the primary flow (onboarding → create manager), the pipeline works perfectly. For edge cases (resume existing session, mid-onboarding refresh, multi-channel complexity), there are unresolved gaps.

**Race conditions?** **Low risk for v1.** Discovery showed Cortex review has locks and manifests; onboarding writes are simpler. But if a user simultaneously chats with Cortex in web + Telegram, both runtimes could race on `common.md` writes. This is unlikely in practice but worth noting.

### 4. Implementation Feasibility ⭐⭐⭐⭐ (4/5)

**Strengths**:
- Low-churn overlay approach respects existing architecture
- No major refactoring required
- Backend/UI split is clean and realistic
- Test plan is comprehensive and covers key flows
- Builds on proven primitives (existing session creation, knowledge injection, WS transport)

**Weaknesses**:
- Prompt injection mechanics are underspecified (see Priority 1 #2)
- UI first-launch routing changes are described but not detailed
  - "route/select the root Cortex session automatically" — how?
  - Does this replace the current default `__default__` subscription?
  - What if auth is unconfigured when user opens the page?
- Integration with existing Settings → Auth flow is hand-wavy
  - "after successful auth setup, route back to Cortex"
  - Current auth setup doesn't have a "success callback" path
- No migration script or upgrade testing plan

**Are the steps realistic?** **Yes, but with gaps.** Backend changes are straightforward. UI changes are more complex than the plan suggests, especially around routing and state management.

**Missed integration points from discovery**:
- Cortex dashboard already exists and is REST/poll-based; onboarding state would need to integrate there
- Settings → Authentication is a dialog, not a full route; "route back to Cortex after auth" doesn't map cleanly to the current UI structure
- Mobile push service would send notifications for onboarding messages; is that desired?

### 5. Edge Cases ⭐⭐⭐ (3/5)

**Covered well**:
- User skips entirely → `deferred` state, no pestering
- User wants to redo later → manual re-entry action
- Partial onboarding survives refresh → draft state persistence
- Existing installs → migration detection + opt-in
- Manager created before onboarding finishes → allowed, manager uses partial context

**Covered poorly**:
- Multi-channel onboarding (Slack/Telegram first contact) → deferred as "product decision" but it's an active hazard (see Priority 1 #3)
- LLM misbehavior (loops, refusals, hallucinations) → no fallback (see Priority 2 #8)
- Onboarding state corruption (file deleted, invalid JSON) → no recovery path
- User changes name/preferences after onboarding → Cortex can update, but manager prompt doesn't acknowledge this
- Concurrent onboarding from multiple channels → undefined behavior

**Missing edge cases**:
- What if user opens multiple browser tabs and onboarding runs in both?
- What if onboarding writes fail (disk full, permissions error)?
- What if `common.md` already has user-written content before onboarding runs?
- What if user manually edits onboarding state file while onboarding is active?

**Important edge cases** are mostly covered. **Critical edge cases** (multi-channel, state corruption, concurrent access) are missing or deferred.

### 6. Tone and UX ⭐⭐⭐⭐ (4/5)

**Would this feel good for a first-time user?** **Yes, with caveats.**

**Positive signals**:
- Skip is easy and guilt-free
- Completion feels like progress, not paperwork
- Terse users get terse experience, chatty users get guided experience
- No forced form fields or setup wizard UI

**Concerns**:
- Opening pitch is too utilitarian: "I can learn your defaults so future managers start with a better read on you"
  - This front-loads efficiency over welcome
  - Better: lead with capability/value, *then* mention efficiency
- No explicit "here's what Forge can do" pitch for users who don't know what to ask
- Transition from onboarding → manager creation is described as "obvious" but might not be
  - User finishes onboarding, Cortex says "create your first manager when ready"
  - UI shows "New Manager" button (already present)
  - No visual change or new affordance appears
  - User might not realize anything happened

**Cringe factor?** **Very low.** No personality theater, no "we're so excited!" energy, no hand-holding. It's professional, grounded, and adaptive.

**But it's a bit... dry?** The tone is respectful and efficient, but it might feel clinical to non-technical users. Example B is warmer, but Example A reads like a senior engineer helping a junior engineer — which is fine for that persona, but might alienate other user types.

**Recommendation**: Add one sentence of genuine warmth/welcome at the very start, *before* the utility pitch:
```
Hey — I'm Cortex, and I'm here to help you get the most out of Forge. 
Before you create your first manager, I can learn a bit about how you like 
to work — or we can skip that and jump straight in. What sounds better?
```

---

## Comparative Analysis: Plan vs. Discovery Artifacts

### Discovery alignment check

**First-launch behavior** (ONBOARDING-DISCOVERY-FIRST-LAUNCH.md):
- ✅ Plan correctly identifies that no explicit first-launch flag exists today
- ✅ Plan correctly identifies that Cortex is auto-created on boot
- ✅ Plan correctly identifies that first regular manager goes through `createManager()`
- ✅ Plan correctly identifies that auth is not currently gated before manager creation
- ⚠️ Plan understates the multi-channel complexity (see Priority 1 #3)

**Initial prompts** (ONBOARDING-DISCOVERY-INITIAL-PROMPTS.md):
- ✅ Plan correctly separates user-level (current bootstrap) from project-level (new manager prompt)
- ✅ Plan correctly identifies that Cortex doesn't get a bootstrap message today
- ✅ Plan correctly maps memory injection paths
- ✅ Plan correctly identifies that manager bootstrap is profile-scoped, not session-scoped
- ⚠️ Plan doesn't address prompt mode coexistence with Cortex operational behavior (see Priority 1 #2)

**Cortex capabilities** (ONBOARDING-DISCOVERY-CORTEX-CAPABILITIES.md):
- ✅ Plan correctly identifies that knowledge writes are immediate on disk
- ✅ Plan correctly identifies that runtime reload is not obvious
- ✅ Plan correctly identifies that Cortex root session is the natural onboarding surface
- ⚠️ Plan treats runtime reload as "optional" when it's actually a UX dependency (see Priority 1 #1, revised assessment)
- ⚠️ Plan doesn't address multi-channel source context preservation (see Priority 1 #3)

**Overall discovery integration**: **Strong.** The plan clearly used the discovery artifacts to inform design decisions. The few gaps are mostly in operational details rather than fundamental misunderstandings.

---

## Risk Assessment

### High risk (could break UX if not addressed)
1. Prompt mode boundary/transition (Priority 1 #2)
2. Multi-channel reply routing (Priority 1 #3)
3. Onboarding draft state location/ownership (Priority 2 #7)

### Medium risk (could cause confusion or frustration)
4. Common knowledge evidence standards mismatch (Priority 2 #4)
5. Manager bootstrap lacks concrete inspection strategy (Priority 2 #5)
6. Skip/defer re-activation not clearly defined (Priority 2 #6)
7. No fallback for stalled conversations (Priority 2 #8)

### Low risk (polish issues, not blockers)
8. Completion milestone feels flat (Priority 3 #9)
9. Tentative signals not explicitly marked (Priority 3 #10)
10. Migration heuristic missing auth check (Priority 3 #12)

---

## Go/No-Go Verdict

**GO WITH REVISIONS**

**Rationale**: The core design is sound, well-researched, and aligns with the existing architecture. The separation of concerns (Cortex for user, manager for project) is the right call. The adaptive prompt examples are strong. The implementation plan is realistic.

**However**: The three Priority 1 issues are genuine blockers:
1. Runtime reload needs explicit handling (revised assessment: not a blocker for happy path, but needs clear documentation)
2. Prompt activation/deactivation boundary is underspecified and will cause implementation confusion
3. Multi-channel onboarding is an active hazard, not a "later decision"

**Recommended next steps**:
1. Resolve Priority 1 issues through design revision or explicit scoping
2. Address Priority 2 issues #4, #5, #6 (these improve quality without adding complexity)
3. Implement and test core flows: web-only, terse user, skip-defer
4. Add multi-channel support as a second phase (but specify target-routing requirements now)
5. Validate prompt mode switching with real Cortex runtime tests

**Timeline impact**: Addressing Priority 1 issues should add 1-2 days of design/alignment work but will prevent significant rework later.

---

## Positive Highlights (What's Done Really Well)

1. **The three example conversations are excellent teaching tools.** They show exactly how the prompt should adapt without being prescriptive.

2. **The revised manager prompt table (stays/removed/new) is a clarity win.** Implementation teams can use this directly.

3. **The "Cortex learns the person; managers learn the project" principle is a strong north star.** Every design decision maps cleanly to this.

4. **The low-churn overlay approach respects the existing codebase.** No unnecessary refactoring, no "rewrite Cortex from scratch" scope creep.

5. **The activation state machine is well-thought-out.** `not_started`, `active`, `deferred`, `completed`, `migrated` covers all meaningful states without over-engineering.

6. **The testing section is comprehensive and realistic.** It covers happy paths, edge cases, and backward compatibility.

---

## Final Recommendation

**Proceed with implementation after addressing Priority 1 blockers.**

The plan is strong. The discovery is thorough. The design is sound. The risks are manageable.

Fix the prompt boundary issue, specify multi-channel routing, and document the runtime reload constraint clearly. Then ship it.

---

**Total findings**: 12 (3 Priority 1, 5 Priority 2, 4 Priority 3)  
**Verdict**: GO WITH REVISIONS  
**Blockers**: Priority 1 issues #2 and #3 must be resolved before implementation begins

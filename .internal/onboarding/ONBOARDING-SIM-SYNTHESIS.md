# Cortex Onboarding Simulation Synthesis

Sources:
- `ONBOARDING-SIM-TERSE-DEV.md`
- `ONBOARDING-SIM-BEGINNER.md`
- `ONBOARDING-SIM-SKIPPER.md`
- `ONBOARDING-SIM-CHATTY.md`
- `ONBOARDING-SIM-MINIMAL.md`
- current prompt: `apps/backend/src/swarm/operational/cortex-onboarding.md`

## 1. Ratings summary table

| Persona | Rating | Key strengths | Key weaknesses |
|---|---:|---|---|
| Terse senior developer | 9/10 | Matches terse energy, asks high-signal operational questions, ends quickly, bridges cleanly to action | Prompt does not explicitly tell Cortex when to stop early for terse users; only one technical example exists; use-case question may be unnecessary once enough signal is captured |
| Beginner / non-technical user | 9/10 | Plain-English tone, reassuring without being patronizing, preference questions stay practical, strong handoff to first useful action | Prompt is more optimized for technical users than beginners; lacks beginner example; preference categories need more explicit translation into everyday language |
| Impatient skipper | 9/10 | Skip/defer behavior is already strong, respects time, clean move to “create your first manager” | Prompt leaves too much room for improvisation in exact wording; should make the skip path single-message and explicitly forbid “one more quick question” |
| Chatty explorer | 8.5/10 | Handles curiosity well, avoids product-tour drift, gently redirects back to durable preferences, wraps before becoming an interview | Prompt needs clearer guidance for mixed verbosity signals, lightweight orientation answers, and storing “steer me back when I tangent” as a valid durable preference |
| Minimal info giver | 8/10 | Accepts sparse input, stays low-friction, does not force a full profile, stops at a natural point | Ambiguous replies like “whatever works” are easy to over-interpret; prompt needs stronger tentative/flexible fact guidance and a clearer sparse-input stopping rule |

**Average rating:** 8.7/10

## 2. Common themes across simulations

Patterns that appeared in multiple scenarios:

1. **The core prompt is fundamentally solid.**
   Across all five simulations, the baseline behavior is good: short replies, good energy matching, avoidance of product-tour drift, and good emphasis on durable cross-project defaults.

2. **The biggest gap is not overall strategy — it is precision.**
   The prompt already points in the right direction, but it needs sharper execution rules for:
   - when to stop
   - how to handle vague answers
   - how to handle onboarding questions without drifting into explanation mode
   - how to adapt language for beginners

3. **Examples are the highest-leverage missing ingredient.**
   Multiple simulations independently called for more examples:
   - terse fast-completion example
   - beginner example
   - skip/defer example
   - curious technical user who asks “what is this / how does it work?”

4. **Completion threshold is too implicit.**
   Several scenarios noted that Cortex could benefit from a more explicit rule like “3-4 useful facts is enough” or “name + technical level + 2-4 defaults is enough.” Right now the prompt says perfection is not required, but it does not strongly anchor when to stop.

5. **Ambiguity handling needs to be more concrete.**
   The prompt already says weak implications should stay tentative or unsaved, but simulations showed a recurring edge case: vague answers such as “whatever works,” “either is fine,” or “brief” can be summarized too strongly unless the prompt gives concrete examples.

6. **Beginner adaptation needs explicit plain-language guidance.**
   The prompt says to match energy and use guided plain-English replies for non-technical users, but it does not explicitly say to translate internal categories like autonomy, risk escalation, and update cadence into normal language.

7. **The prompt needs a safe “briefly answer, then redirect” pattern.**
   The chatty simulation exposed an important middle ground: users may ask onboarding-adjacent questions, and Cortex should answer enough to be helpful without opening a product tour.

## 3. Top prompt improvements

Ranked by likely impact.

### 1) Add an explicit completion threshold and early-stop rule

**What the current prompt says/does**
- Says: “You do NOT need a perfect profile.”
- Says: “Onboarding is successful once you have enough signal to improve future sessions OR the user clearly wants to move on.”
- Says: “If they are ready to work, unblock them quickly.”

This is directionally right, but still leaves too much room for over-questioning.

**What it should say/do instead**
Make the stopping rule explicit so Cortex can confidently finish after a small number of useful facts, especially for terse or minimal users.

**Personas that benefit**
- Terse senior developer
- Minimal info giver
- Impatient skipper
- Chatty explorer

**Exact suggested prompt text**
Add under **Completion behavior**:

> - In most cases, **name + technical level + any 2-4 durable working defaults** is enough.
> - For terse or low-elaboration users, **3-4 useful facts total is a successful onboarding**.
> - Prefer finishing early over asking lower-value follow-up questions once the user can be usefully unblocked.
> - If the user is already ready to start work, stop collecting preferences and transition immediately.

---

### 2) Add concrete persona examples for the main edge cases

**What the current prompt says/does**
It includes only one short technical-user example.

**What it should say/do instead**
Add 3-4 compact examples that anchor the most failure-prone paths.

**Personas that benefit**
- All personas
- Especially beginner, skipper, terse, and chatty users

**Exact suggested prompt text**
Add under **Conversation style** or a new **Examples** section:

> **Example: terse technical user finishing quickly**
> - User: “Marcus. Developer. Keep it short.”
> - Cortex: “Good to meet you, Marcus. I’ll keep this concise. Should managers mostly execute and report, or check in before making changes?”
> - After 1-2 more high-signal answers: “Got it: concise, autonomous by default, and only interrupt for risk or ambiguity. That’s enough to get started — go ahead and create your first manager.”
>
> **Example: beginner user**
> - User: “I’m non-technical and not really sure where to start.”
> - Cortex: “That’s totally fine — I can keep this simple and practical. What would help more right now: getting ideas, doing research, or drafting something?”
>
> **Example: clear skip**
> - User: “skip”
> - Cortex: “No problem — I’ll defer onboarding for now. Go ahead and create your first manager, and we can pick up preferences later if useful.”
>
> **Example: curious technical user asking how the system works**
> - User: “Before I trust this, how does it actually work?”
> - Cortex: “At a high level, think of it as help you can steer without micromanaging. I’ll keep onboarding lightweight here: do you want concise execution by default, or more reasoning up front?”

---

### 3) Require natural-language translation of preference categories for beginners

**What the current prompt says/does**
The prompt lists useful durable facts using internal-ish categories:
- response verbosity preference
- explanation depth preference
- update cadence preference
- autonomy default
- risk escalation preference

That is good for design, but not explicit enough for beginner-facing phrasing.

**What it should say/do instead**
Tell Cortex to never ask those as labels, and instead translate them into normal language.

**Personas that benefit**
- Beginner / non-technical user
- Chatty explorer
- Minimal info giver

**Exact suggested prompt text**
Add under **Conversation style**:

> - Treat the categories below as **internal concepts, not user-facing labels**.
> - Ask about them in everyday language.
>   - Instead of “update cadence,” ask “Do you want short progress updates, or only when something changes?”
>   - Instead of “autonomy default,” ask “Should managers mostly just execute, or check in before making changes?”
>   - Instead of “risk escalation preference,” ask “If something seems risky or important, should I check with you first?”
> - For non-technical users, prefer plain-English phrasing over system terminology.

---

### 4) Add explicit guidance for vague answers and tentative/flexible facts

**What the current prompt says/does**
It says:
- “Weak implications should stay tentative or be left unsaved if they are too fuzzy to be useful.”

That is correct but abstract.

**What it should say/do instead**
Give explicit examples of vague replies and tell Cortex how to summarize them safely.

**Personas that benefit**
- Minimal info giver
- Terse senior developer
- Chatty explorer

**Exact suggested prompt text**
Add under **Evidence and lifecycle rules**:

> - If the user gives a vague answer like “whatever works,” “either is fine,” or “I’m flexible,” treat it as **flexible / low-friction**, not as a strong preference.
> - Do not restate ambiguous answers as stronger commitments in your summary.
> - Save vague answers only if your onboarding state supports tentative or flexible defaults; otherwise leave them unsaved.
> - If a fact is weak, either summarize it softly (“flexible on check-ins”) or omit it.

---

### 5) Add a “briefly answer, then redirect” rule for onboarding-adjacent questions

**What the current prompt says/does**
It strongly discourages architecture/internals/product tours, which is good.
But it does not explicitly say what to do when the user asks a reasonable orientation question during onboarding.

**What it should say/do instead**
Allow a short, practical answer, then return to preference capture.

**Personas that benefit**
- Chatty explorer
- Beginner / non-technical user

**Exact suggested prompt text**
Add under **Boundaries**:

> - If the user asks an onboarding-adjacent orientation question (for example, “what can this do for me?” or “how should I think about this?”), answer it briefly in **1-2 practical sentences**, then return to onboarding.
> - Prefer role-based examples over architecture or internals.
> - Do not let an orientation answer turn into a product tour.

And add this line under **Conversation style**:

> - A good pattern is: **briefly answer -> capture one durable preference -> move on or finish**.

---

### 6) Clarify how to reconcile mixed verbosity signals

**What the current prompt says/does**
It treats response verbosity and explanation depth as separate useful facts, which is good, but does not explain how to handle users who say both:
- “be concise by default” and
- “medium-length answers are usually right unless I ask for a deep dive”

**What it should say/do instead**
Tell Cortex to distinguish execution brevity from explanation depth, or to let later refinements supersede earlier broad statements.

**Personas that benefit**
- Chatty explorer
- Terse senior developer

**Exact suggested prompt text**
Add under **Evidence and lifecycle rules**:

> - Some users will distinguish between **execution brevity** and **explanation depth**.
> - If they do, preserve that distinction rather than collapsing everything into one verbosity preference.
> - Later, more specific statements should refine earlier broad ones.
> - Example: “concise execution summaries, but medium-length explanations by default, with deep dives on request.”

---

### 7) Strengthen the skip/defer path into a strict one-message default

**What the current prompt says/does**
It already says to honor skip/defer immediately and not keep probing.

**What it should say/do instead**
Make the exact behavior stricter so the model does not improvise a “just one quick thing” reply.

**Personas that benefit**
- Impatient skipper
- Terse senior developer

**Exact suggested prompt text**
Replace the current skip block with this stronger version:

> **Skip / defer behavior:**
> - If the user says they want to skip, move fast, or do this later, honor that immediately.
> - Mark onboarding deferred using the status tool before replying that it is fine to move on.
> - On a clear skip/defer, respond with **one short message and no follow-up question** unless the user asks one.
> - Do not try to salvage one more onboarding fact after a skip.
> - Immediately point them toward creating their first manager in that same reply.

---

### 8) Add an optional first-use handoff for beginners and uncertain users

**What the current prompt says/does**
It says to point the user toward creating their first manager.
That is good, but for beginners it may not be enough.

**What it should say/do instead**
Allow Cortex to offer a copyable first prompt or a small choice of starter tasks after onboarding is complete.

**Personas that benefit**
- Beginner / non-technical user
- Chatty explorer

**Exact suggested prompt text**
Add under **Completion behavior**:

> - After a successful onboarding completion, you may offer **one** of these lightweight handoffs if the user seems unsure:
>   - create the first manager now, or
>   - start from a copyable example prompt.
> - For non-technical users, a concrete first-use example is often more helpful than extra onboarding questions.

## 4. Scenario-specific fixes

These are narrower improvements that matter mainly for one persona type.

### Terse senior developer
- **Fix:** Avoid redundant probing once “keep it short” already implies low-friction behavior.
- **Prompt addition:**
  > - If a terse technical user clearly signals brevity (“keep it short,” “just the essentials”), do not separately probe explanation depth unless it materially changes behavior.

### Beginner / non-technical user
- **Fix:** Explicitly allow one short reassurance move before asking the next question.
- **Prompt addition:**
  > - If the user seems unsure or intimidated, one brief reassurance sentence is appropriate before the next practical question.
  > - Keep reassurance adult, simple, and non-patronizing.

### Impatient skipper
- **Fix:** Make the response formula deterministic.
- **Prompt addition:**
  > - For a one-word skip like “skip,” “later,” or “not now,” do not add explanation beyond a single defer acknowledgment and handoff.

### Chatty explorer
- **Fix 1:** Treat “gently steer me back if I tangent” as a valid durable collaboration preference.
- **Prompt addition:**
  > - Cross-project collaboration preferences may include conversation-shaping defaults such as “ask a quick clarifying question first” or “gently steer me back if I drift.”

- **Fix 2:** Permit lightweight memory-context answers without opening a philosophy discussion.
- **Prompt addition:**
  > - If asked what context persists, describe it narrowly as lightweight preferences and recurring defaults unless deeper explanation is necessary.

### Minimal info giver
- **Fix:** Force soft summaries for sparse ambiguous input.
- **Prompt addition:**
  > - When summarizing sparse input, prefer soft language like “mostly coding work” or “flexible on check-ins” instead of sharper commitments the user did not explicitly make.

## 5. Overall assessment

**Assessment:** the current prompt is already good enough with targeted fixes. It does **not** need a significant rewrite.

Why:
- All five simulations landed in the **8-9/10** range.
- The prompt’s fundamentals are strong: short replies, durable-fact focus, skip support, anti-product-tour boundaries, and persistence discipline.
- The main failures are **edge-case precision failures**, not structural failures.

### Recommended path
1. **Do not rewrite the prompt from scratch.**
2. **Tighten it with explicit examples and decision rules.**
3. **Prioritize these changes first:**
   1. completion threshold
   2. additional examples
   3. vague-answer handling
   4. beginner plain-language translation
   5. brief-answer-then-redirect rule

If those are added, the onboarding prompt should become materially more consistent across terse, beginner, skip, chatty, and minimal-input users without losing its current strengths.
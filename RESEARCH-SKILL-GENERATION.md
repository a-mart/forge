# Research: Autonomous Skill Generation by Cortex

> **Status:** Research — no code changes  
> **Date:** 2026-03-23

---

## 1. Anatomy of Existing Skills

### 1.1 SKILL.md — The Core Artifact

Every skill is a directory containing a `SKILL.md` file with YAML frontmatter + Markdown body.

**Frontmatter fields:**
```yaml
---
name: skill-name              # Used for dedup and display
description: One-line summary  # Shown in <available_skills> block injected into prompts
env:                           # Optional — declares required env vars
  - name: SOME_API_KEY
    description: What this key is for
    required: true
    helpUrl: https://where-to-get-it
---
```

**Body:** Free-form Markdown. Typical sections:
- **Setup/prerequisites** — what the agent needs before using the skill
- **Commands** — shell commands the agent should run (referencing scripts relative to the skill dir)
- **Options/flags** — CLI interface documentation
- **Output format** — what the scripts return (usually JSON `{ "ok": true, ... }`)
- **When to use** — guidance on when the skill applies

### 1.2 Supporting Scripts

Many skills include executable scripts alongside `SKILL.md`:

| Skill | Scripts |
|-------|---------|
| `brave-search` | `search.js`, `content.js` (+ `package.json` for deps) |
| `cron-scheduling` | `schedule.js` (+ `package.json`) |
| `image-generation` | `generate.js` |
| `slash-commands` | `slash-commands.js` |
| `chrome-cdp` | `scripts/cdp.mjs` |
| `pdf-generator` | `render.sh`, `brand.css`, `example.html` |
| `parallels-vm` | `scripts/vm.mjs` |

Scripts are *not* required. The `agent-browser` skill is documentation-only — it tells agents how to use a globally-installed CLI. The `memory` skill is also pure instructions (agents use their built-in `read`/`edit`/`write` tools).

### 1.3 Skill Complexity Spectrum

| Level | Example | What's in the directory |
|-------|---------|------------------------|
| **Instructions-only** | `memory`, `agent-browser` | `SKILL.md` only |
| **Docs + script** | `image-generation` | `SKILL.md` + one `.js` file |
| **Docs + multi-script** | `brave-search`, `chrome-cdp` | `SKILL.md` + multiple scripts + optional `package.json` |
| **Rich design system** | `pdf-generator` | `SKILL.md` + CSS + HTML templates + render script |

---

## 2. Skill Discovery and Injection

### 2.1 Scan Hierarchy (from `skill-metadata-service.ts`)

The `SkillMetadataService` scans four directories in order:

1. **`~/.forge/skills/`** — Local user skills (machine-specific, never committed)
2. **`<repo>/.swarm/skills/`** — Repo-scoped skills (committed with a project)
3. **`<repo>/apps/backend/src/swarm/skills/builtins/`** — Builtin skills (shipped with Forge)
4. **Fallback builtins** — Resolved from the installed package location

Within each directory, it enumerates subdirectories looking for `SKILL.md` files. Skill names are normalized (lowercased) and deduplicated — first-found wins.

**Key implication for generation:** A skill written to `~/.forge/skills/<name>/SKILL.md` is automatically discovered on the next metadata reload. No registration step needed.

### 2.2 How Skills Reach Agents

1. **Metadata summary** — On startup, all skill metadata (name, description, path) is collected.
2. **System prompt injection** — The swarm manager builds the system prompt. Each skill's full `SKILL.md` content is read and appended as a labeled section. The `<available_skills>` XML block (name + description + path) is also injected so agents know which skills exist and can `read` them on demand.
3. **Lazy loading** — Agents see the skill list in their prompt. They `read` the full SKILL.md when a task matches the description. They don't carry all skill contents in context at all times.

### 2.3 Frontmatter Parsing

`skill-frontmatter.ts` does lightweight YAML-subset parsing (not a full YAML parser). It extracts:
- `name` (string)
- `description` (string)
- `env` / `envVars` (array of `{ name, description, required, helpUrl }`)

No other frontmatter fields are supported. This is important — generated skills must stay within this schema.

---

## 3. Slash Commands vs Skills

### 3.1 Structure Comparison

| Dimension | Slash Command | Skill |
|-----------|--------------|-------|
| **Storage** | JSON entry in `~/.forge/shared/slash-commands.json` | Directory with `SKILL.md` + optional scripts |
| **Content** | `{ name, prompt }` | Markdown instructions + optional executables |
| **Scope** | Global (shared across all profiles/sessions) | Global (local) or repo-scoped |
| **Injection** | UI-level autocomplete; expands to prompt text when user types `/name` | Injected into system prompt as available context |
| **Capabilities** | Text substitution only — the prompt replaces user input | Can instruct agents to run scripts, use specific tools, follow workflows |
| **Management** | CRUD via REST API or CLI script | File system (create/delete directories) |
| **Discovery** | Loaded from JSON file | Scanned from skill directories |
| **Trigger** | Explicit user invocation via `/name` in chat | Agent reads when task matches description |

### 3.2 When to Use Which

**Slash command** is better when:
- The pattern is a simple prompt template ("do X with Y context")
- The user wants a one-keystroke shortcut
- No scripts or tool orchestration needed
- Example: `/summarize` → "Summarize the latest changes and open risks."

**Skill** is better when:
- The pattern requires multi-step instructions
- External scripts or APIs are involved
- The agent needs to know *how* to do something, not just *what*
- The capability should be available to workers (not just through user input)
- Example: "Search the web using Brave API" requires search.js + content.js + API key setup

---

## 4. Generation Feasibility

### 4.1 What Cortex Would Need to Generate

#### Tier 1: Slash Command (trivial)

**Minimum artifact:** A JSON entry with `name` + `prompt`.

**Cortex can already do this** using the `slash-commands` skill's CLI:
```bash
node apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js create \
  --name "review-pr" \
  --prompt "Review the current PR. Check for correctness, style, test coverage, and potential regressions."
```

**Effort:** Zero new infrastructure. Cortex just runs the existing CLI.

#### Tier 2: Instructions-Only Skill (straightforward)

**Minimum artifact:** A directory with a single `SKILL.md` file.

**What Cortex generates:**
```
~/.forge/skills/<skill-name>/
└── SKILL.md
```

The SKILL.md contains:
1. Frontmatter (`name`, `description`)
2. Markdown instructions for agents

**Example generation flow:**
1. Cortex detects a pattern (e.g., user repeatedly asks agents to format TypeScript with specific rules)
2. Cortex writes `~/.forge/skills/ts-format-conventions/SKILL.md`
3. On next agent startup, the skill appears in `<available_skills>`

**Effort:** Cortex needs `write` tool access to `~/.forge/skills/`. No new APIs needed.

#### Tier 3: Skill with Scripts (complex)

**What Cortex generates:**
```
~/.forge/skills/<skill-name>/
├── SKILL.md
├── script.js (or .mjs)
└── package.json (if deps needed)
```

**Challenges:**
- Generated scripts must be correct and safe
- Dependencies may need `npm install`
- Scripts need to follow the output convention (`{ "ok": true/false, ... }`)
- Error handling must be robust

**Effort:** Significantly harder. Requires validation, testing, and possibly sandboxing.

### 4.2 Recommended Starting Point: Tier 1 + Tier 2 Only

Generated scripts (Tier 3) carry execution risk and should be deferred. The first implementation should focus on:

1. **Slash commands** — pure prompt templates, zero execution risk
2. **Instructions-only skills** — teach agents *how* to do things using existing tools, no new scripts

These two tiers cover the majority of useful patterns while keeping risk minimal.

---

## 5. Detection → Generation Pipeline

### 5.1 Pattern Detection Sources

Cortex already reviews sessions and extracts durable signals. The same pipeline could detect:

| Signal | Example | Generated Artifact |
|--------|---------|-------------------|
| **Repeated prompts** | User types similar review instructions 5+ times | Slash command |
| **Repeated workflows** | Agents consistently follow the same multi-step process | Instructions-only skill |
| **Recurring tool sequences** | `bash(git diff) → read(file) → edit(file) → bash(test)` | Skill with workflow instructions |
| **User corrections** | User corrects the same agent behavior repeatedly | Skill with explicit "do/don't" rules |
| **Cross-session patterns** | Same setup steps appear in multiple sessions | Skill with setup guide |

### 5.2 Generation Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. DETECT                                                   │
│    Cortex review cycle spots a recurring pattern             │
│    across 3+ sessions or 5+ occurrences in one session       │
│                                                              │
│ 2. DRAFT                                                     │
│    Cortex generates a candidate artifact:                    │
│    - Slash command JSON, or                                  │
│    - SKILL.md content                                        │
│    Writes draft to ~/.forge/shared/knowledge/.cortex-tmp/    │
│                                                              │
│ 3. PROPOSE                                                   │
│    Cortex presents the candidate to the user:                │
│    "I noticed you frequently [pattern]. Want me to create    │
│     a [slash command / skill] for this?"                     │
│    Shows the proposed content for review.                    │
│                                                              │
│ 4. USER APPROVAL                                             │
│    User approves, modifies, or rejects.                      │
│    (Use existing choice-picker for structured approval.)     │
│                                                              │
│ 5. INSTALL                                                   │
│    - Slash command: CLI call to create                       │
│    - Skill: write to ~/.forge/skills/<name>/SKILL.md         │
│    - Trigger skill metadata reload                           │
│                                                              │
│ 6. VERIFY                                                    │
│    Next agent startup confirms the skill appears             │
│    in <available_skills> block.                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 Where Detection Lives

Two options:

**Option A: Part of existing review cycle.**
Cortex already extracts durable signals from sessions. Add "recurring pattern" as a new signal type in the extraction prompt. When synthesis finds patterns with 3+ occurrences, trigger the generation flow.

**Option B: Dedicated detection pass.**
A separate scheduled task that runs less frequently (daily or weekly), specifically looking for automation candidates across recent sessions. Lighter touch, lower noise.

**Recommendation:** Option A — piggyback on the existing review infrastructure. Cortex already reads sessions, extracts patterns, and promotes knowledge. Adding "automatable pattern" as a signal type is a natural extension.

---

## 6. Safety and Validation

### 6.1 Slash Commands — Low Risk

- **Content is just text** — no execution, no side effects
- **Validation:** Name format check (alphanumeric + hyphens + underscores), non-empty prompt
- **Rollback:** Delete via CLI or REST API
- **Risk:** A bad prompt wastes one chat turn at worst

### 6.2 Instructions-Only Skills — Low-Medium Risk

- **Content is advisory** — agents follow instructions using existing tools
- **Validation concerns:**
  - Instructions shouldn't reference nonexistent tools or paths
  - Instructions shouldn't conflict with existing skills
  - Instructions should be clear enough that agents can follow them
- **Name collision check:** Verify no existing skill has the same normalized name
- **Rollback:** Delete the directory from `~/.forge/skills/`
- **Risk:** Bad instructions could confuse agents, but won't cause direct harm since agents already have safety boundaries

### 6.3 Skills with Scripts — High Risk (defer)

- **Execution risk:** Scripts run with the agent's OS permissions
- **Supply chain risk:** Dependencies could introduce vulnerabilities
- **Correctness risk:** Buggy scripts could corrupt data or fail silently
- **Mitigation if eventually implemented:**
  - Require user to explicitly review and approve script content
  - Scripts must use the JSON output convention for error handling
  - Consider running in a sandboxed subprocess
  - Require test coverage before installation

### 6.4 User Approval Flow

For all generated artifacts, Cortex should:

1. **Never auto-install without approval** — always present and wait for explicit user confirmation
2. **Show the full content** — user sees exactly what will be created
3. **Use the choice picker** (`present_choices` tool) for structured approval:
   ```
   Choices:
   1. ✅ Install as-is
   2. ✏️ Edit first (show in chat for modification)
   3. ❌ Skip this suggestion
   4. 🚫 Don't suggest this pattern again
   ```
4. **Log the decision** — track which patterns were accepted/rejected to improve future suggestions

### 6.5 Rollback

Generated artifacts should be tagged so they can be identified and cleaned up:

- **Slash commands:** Add a `source: "cortex-generated"` field to the JSON entry (requires minor schema extension)
- **Skills:** Include a comment in the SKILL.md frontmatter or a `_generated.json` metadata file in the skill directory:
  ```json
  {
    "generatedBy": "cortex",
    "generatedAt": "2026-03-23T16:00:00Z",
    "sourcePattern": "repeated PR review instructions",
    "approvedBy": "user",
    "approvedAt": "2026-03-23T16:05:00Z"
  }
  ```

A `/cortex skills` or settings UI panel could list all generated skills with options to disable or delete.

---

## 7. Concrete Examples

### Example 1: PR Review Slash Command

**Detected pattern:** User sends variations of "review the PR, check tests, look at edge cases" in 6 different sessions.

**Generated artifact: Slash Command**

```json
{
  "name": "review-pr",
  "prompt": "Review the current PR branch against main. Check for:\n1. Correctness — does the code do what it claims?\n2. Test coverage — are edge cases tested?\n3. Style — does it follow project conventions?\n4. Regressions — could this break existing behavior?\n\nProvide a structured summary with findings and a pass/fail recommendation."
}
```

**Why slash command:** It's a prompt template. No multi-step orchestration or scripts needed. User can trigger it with `/review-pr`.

---

### Example 2: Database Migration Workflow Skill

**Detected pattern:** Across 4 sessions, agents are repeatedly guided through the same migration steps: generate migration, apply to dev DB, verify schema, run seed, test.

**Generated artifact: Instructions-Only Skill**

```
~/.forge/skills/db-migration/SKILL.md
```

```markdown
---
name: db-migration
description: Step-by-step workflow for creating and applying database migrations safely.
---

# Database Migration

Use this skill when the user asks to create, modify, or apply database migrations.

## Workflow

### 1. Generate the migration

```bash
pnpm exec drizzle-kit generate --name "<descriptive-name>"
```

### 2. Review the generated SQL

Read the migration file in `drizzle/migrations/` and verify it matches intent.
If it includes destructive changes (DROP, ALTER column type), flag for explicit user confirmation.

### 3. Apply to development

```bash
pnpm exec drizzle-kit push
```

### 4. Verify schema

```bash
pnpm exec drizzle-kit check
```

### 5. Run seeds if needed

```bash
pnpm exec tsx scripts/seed.ts
```

### 6. Run tests

```bash
pnpm test
```

### Safety rules
- Never apply migrations to production without explicit user confirmation.
- Always back up the database before destructive migrations.
- If a migration fails mid-way, do NOT retry automatically — report the error and wait.
```

**Why skill (not slash command):** Multi-step workflow with conditional logic and safety rules. Agents need detailed instructions, not just a prompt.

---

### Example 3: Test-Driven Bug Fix Skill

**Detected pattern:** User repeatedly asks agents to follow a specific bug-fix workflow: reproduce with a failing test first, then fix, then verify.

**Generated artifact: Instructions-Only Skill**

```
~/.forge/skills/tdd-bugfix/SKILL.md
```

```markdown
---
name: tdd-bugfix
description: Test-driven bug fix workflow — write a failing test first, then fix the code, then verify all tests pass.
---

# Test-Driven Bug Fix

Use this skill when fixing a reported bug.

## Workflow

### 1. Understand the bug
- Read the bug description carefully.
- Identify the affected code path.
- Determine expected vs actual behavior.

### 2. Write a failing test FIRST
- Create a test that demonstrates the bug.
- Run the test to confirm it fails with the expected symptom.
- Do NOT proceed to the fix until the test is red.

```bash
cd apps/backend && pnpm exec vitest run <test-file> --reporter=verbose
```

### 3. Fix the code
- Make the minimal change needed to fix the bug.
- Do not refactor unrelated code in the same change.

### 4. Verify the fix
- Run the failing test again — it should now pass.
- Run the full test suite to check for regressions:

```bash
pnpm test
```

### 5. Typecheck

```bash
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

### Rules
- Never skip the failing-test step. If the bug can't be reproduced in a test, explain why and get user approval before proceeding.
- If the fix requires touching >3 files, pause and explain the scope to the user before continuing.
```

**Why skill:** Enforces a specific methodology with explicit rules and gates. A slash command can't express conditional logic or sequential dependencies.

---

## 8. Implementation Roadmap

### Phase 1: Manual Generation (no new code)

Cortex can already do all of this today with existing tools:
- Use `slash-commands` skill CLI to create slash commands
- Use `write` tool to create `~/.forge/skills/<name>/SKILL.md`
- Use `speak_to_user` to propose and get approval

**What's needed:** A Cortex archetype/knowledge update describing when and how to suggest generated artifacts. This is a prompt-level change only.

### Phase 2: Structured Detection

Add "automatable pattern" as a signal type in the extraction worker prompts. When Cortex review finds patterns that recur across 3+ sessions, flag them as skill candidates in the review notes.

**What's needed:** Extraction prompt update + a small schema for tracking candidates in `.cortex-notes.md` or a new `.cortex-skill-candidates.json`.

### Phase 3: User Approval UX

Build a UI surface for Cortex-proposed skills:
- Display proposed artifact content
- Accept / edit / reject controls
- List of installed generated skills with delete option

**What's needed:** UI component + REST endpoint for generated-skill management.

### Phase 4: Script Generation (future)

If/when Tier 3 skills are needed:
- Sandboxed script testing before installation
- Automated validation (runs without error, produces expected JSON output)
- User must review script source before approval

---

## 9. Open Questions

1. **Threshold tuning:** How many occurrences before suggesting a skill? Too low = noise, too high = missed opportunities. Starting point: 3 sessions or 5 occurrences in a single session.

2. **Skill retirement:** How should Cortex handle skills that stop being used? Suggest deletion after N weeks of zero usage? Track usage via agent tool-call logs?

3. **Cross-profile skills:** Should generated skills be profile-scoped or global? Current `~/.forge/skills/` is global. A coding project skill may not be relevant to a writing project. Could add `~/.forge/profiles/<profileId>/skills/` but that requires a discovery code change.

4. **Conflict resolution:** What if a generated skill contradicts instructions in `AGENTS.md` or profile memory? The skill's instructions would be in the system prompt alongside those other sources. Need clear precedence rules.

5. **Skill evolution:** If the user's workflow changes, should Cortex update existing generated skills? This risks overwriting user modifications. Better to propose a new version and let the user choose.

6. **Quota for generated skills:** Should there be a cap on how many skills Cortex can generate? Too many skills bloat the system prompt's `<available_skills>` block (though the actual SKILL.md content is lazy-loaded).

---

## 10. Key Findings

1. **The infrastructure already supports generated skills.** Writing a `SKILL.md` to `~/.forge/skills/<name>/` is sufficient — no registration API needed, auto-discovered on next metadata reload.

2. **Slash commands are the lowest-risk starting point** — pure text, CRUD via existing CLI, trivially reversible.

3. **Instructions-only skills cover most valuable patterns** without the risks of generated scripts.

4. **Phase 1 requires zero code changes** — Cortex can generate skills today using existing tools. The missing piece is just the detection logic and user approval workflow in Cortex's own prompt/knowledge.

5. **User approval is non-negotiable.** Auto-installing skills without consent would violate the user's trust and the project's collaboration principles.

6. **The biggest design challenge isn't generation — it's detection.** Knowing *when* a pattern is worth automating requires good signal extraction from session data, which Cortex's review system already does well.

---
name: multi-model-coordination
description: Use when the user explicitly asks for a panel, competing approaches, adversarial or multi-angle review, provider/model diversity, or when a high-risk decision clearly benefits from independent perspectives followed by evidence-based synthesis.
---

# Multi-model Coordination

Use this skill to design a small work graph for deliberate perspective diversity. It is not the
default path for ordinary implementation, planning, research, or review.

## When to use

Read one scenario reference when:

- the user requests multiple models, providers, perspectives, candidates, or a team-style review;
- the user names one of the scenarios below; or
- a consequential, ambiguous choice clearly benefits from independent approaches and synthesis.

When autonomous activation requires confirmation in the selected scenario frontmatter, preview the
purpose and graph shape and ask before creating the graph.

## When not to use

- for routine delegation that the active roster already handles;
- merely because work is large, important, or graph-shaped;
- to create several workers that repeat the same prompt without a reason for independence;
- when one focused worker plus manager acceptance is enough.

## Workflow

1. Read exactly one best-fit scenario reference.
2. Treat its graph as a topology example, not a fixed template. Keep the smallest useful graph.
3. Give parallel nodes distinct questions, lenses, evidence requirements, or solution constraints.
4. Prefer `route: auto`. Select named routes only from the active `[delegationRoster]`; never invent
   model or route ids.
5. Keep contributors independent until their leaf results are accepted. Do not reveal other
   contributors' conclusions in their initial tasks.
6. The manager owns acceptance and normally owns synthesis for two to four bounded results. Add a
   synthesis worker only when the source volume exceeds a bounded manager comparison.
7. Compare evidence and assumptions, not contributor identity or vote count. Preserve material
   dissent and verify the decisive claim before converging.

## Scenario index

- [Parallel exploration](references/parallel-exploration.md) — divide one domain into independent,
  non-overlapping investigations.
- [Adversarial review](references/adversarial-review.md) — test a proposal or implementation from
  distinct failure-oriented lenses.
- [Competing solutions](references/competing-solutions.md) — develop multiple viable approaches to
  the same problem, then select or combine them.
- [Research panel](references/research-panel.md) — investigate an uncertain question through
  different source strategies or provider families.
- [Thorough code review](references/thorough-code-review.md) — review one change through
  correctness, security, design, and operational lenses without duplicating ownership.

## Synthesis packet

Require each contributor to return:

- conclusion or proposed action;
- strongest supporting evidence with source locations;
- assumptions and uncertainty;
- concrete risks or disconfirming evidence;
- focused verification that would change the recommendation.

Synthesis must identify agreements, contradictions, evidence quality, decisive verification, and a
recommended next action. Never collapse unresolved disagreement into false consensus.

## Guardrails

- Keep graph mutations manager-owned and use only routes present in `[delegationRoster]`.
- Do not create parallel writers for one artifact or expose another contributor's conclusion early.
- Do not spend more agents merely to increase vote count.

## Output

Return the accepted outcome, decisive evidence, material dissent, and any remaining verification gap.
Do not narrate the panel mechanics unless they help the user evaluate the result.

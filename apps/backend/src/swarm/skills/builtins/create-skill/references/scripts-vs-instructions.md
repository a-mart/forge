# Scripts vs instructions

Use markdown instructions for judgment. Use helper scripts for determinism.

## Keep it in `SKILL.md` when

- the work is mostly about deciding *whether* or *when* to do something,
- the agent needs to adapt steps based on repo context,
- a rigid script would hide important decision points,
- structured output is not critical.

## Add a helper script when

- the same filesystem scaffolding repeats every time,
- path safety matters,
- the workflow benefits from JSON output,
- validation is mechanical,
- deterministic transforms would otherwise bloat the prompt.

## Heuristic

If the step can be described as “always do the same thing with the same shape,” it probably belongs in a script.

If the step can be described as “decide based on context, then explain why,” it probably belongs in `SKILL.md`.

## Practical default

Start simple:
1. write a strong `SKILL.md`,
2. add a helper script only for the narrow repetitive parts,
3. validate the resulting skill before handoff.

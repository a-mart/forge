---
name: specialist-rosters
description: Inspect, design, create, or update Forge specialist rosters when the user wants to change the available team, task defaults, models, reasoning, fallback, or escalation behavior.
---

# Specialist Rosters

## When to use

Use this skill in a local Builder session when the user asks to inspect, create, update, copy, or improve a specialist roster. A roster is a reusable team of complete specialists. Forge stores rosters globally in `${SWARM_DATA_DIR}/shared/config/delegation-rosters.json` and projects or sessions select one of them.

Run `node ./manage-rosters.mjs` from this skill directory. The helper uses Forge's Settings API so normal validation, revisioning, reference checks, and atomic persistence remain authoritative. Do not edit the storage file directly.

## Do not use this skill when

- The user only wants to select an existing roster for a project or session.
- The user wants to author task-instruction or custom-specialist markdown rather than a roster definition.
- The session is running in Collaboration or a Remote Project. Roster writes are local instance-admin settings; explain that boundary instead of trying to bypass it.

## Workflow

### Shape the roster

Start from the user's operating goal rather than a fixed team topology. A useful roster may optimize for speed, cost, capability, provider diversity, independent judgment, or a particular kind of work.

- Keep the roster as small as the goal permits. Add a specialist only when its task contract, executor, or selection guidance is meaningfully distinct.
- Every specialist combines a task type with its model, reasoning, use/avoid guidance, fallback, and optional escalation.
- Choose only models and reasoning levels returned by `models`.
- Use availability fallback only for model unavailability. Use escalation for a fresh attempt after evidence that the current specialist was not capable enough.
- Let the agent exercise judgment. Do not force a particular provider, model family, specialist count, or escalation chain unless the user asks for it.

Read [references/roster-shape.md](references/roster-shape.md) when authoring a proposal.

### Inspect

```bash
node ./manage-rosters.mjs list
node ./manage-rosters.mjs show --id balanced
node ./manage-rosters.mjs models
```

Use `--url <forge-base-url>` only when the current Forge instance is not available through `FORGE_PORT`, `MIDDLEMAN_PORT`, or the normal local default.

### Create or update

Write the desired complete roster object to a JSON file. The helper owns `revision`; omit it from the proposal.

Preview without changing settings:

```bash
node ./manage-rosters.mjs create --file roster.json
node ./manage-rosters.mjs update \
  --id balanced \
  --expected-revision 3 \
  --file roster.json
```

Apply after the user has asked for the configuration change:

```bash
node ./manage-rosters.mjs create --file roster.json --apply
node ./manage-rosters.mjs update \
  --id balanced \
  --expected-revision 3 \
  --file roster.json \
  --apply
```

An explicit request to create or update a roster is authorization for that scoped local change. Ask a follow-up only when an inferred choice would materially change cost, capability, provider use, or project behavior. If the user asked only for advice or a design, stop at the preview.

After applying, run `show` and report the saved revision and the material routing/model changes. If the expected revision changed, inspect the newer roster and reconcile rather than overwriting it.

## Guardrails

- This helper creates and replaces roster definitions; it does not delete rosters or change which roster is the global, project, or session default.
- Creating a variation is just `show`, adapt the returned definition under a new `rosterId` and name, then `create`.
- Do not invent provider IDs, model IDs, reasoning levels, task types, or references to specialists that are absent from the proposal.
- Do not treat a roster change as permission to restart Forge or alter running worker attempts.

## Output

Report the roster name and id, saved revision, material task-routing or model changes, and whether the result was previewed or applied. Surface validation or revision conflicts without bypassing them.

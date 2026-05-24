---
name: forge-project-resources
description: Author repo-root .forge project resources, including skills, specialists, reference docs, Project Agent definitions, Forge extensions, and Pi extensions/settings.
---

# Forge Project Resources

Use this skill when you need to add or update repo-root `.forge/` resources that should travel with one repository.

## Use this skill when
- you are editing `<repo>/.forge/skills/`, `.forge/specialists/`, `.forge/reference/`, `.forge/project-agents/`, `.forge/extensions/`, or `.forge/pi/`
- you need a quick reminder of repo vs global/profile placement
- you want the smallest safe layout for a new project resource

## Do not use this skill when
- the resource belongs in a global path like `~/.forge/skills/` or `~/.forge/agent/extensions/`
- the resource belongs to one profile under `~/.forge/profiles/<profileId>/...`
- you are creating a profile-local Project Agent from an existing session; this skill is for repository-backed Project Agent definitions under `.forge/project-agents/`
- you just need a new reusable skill; use `create-skill` instead

## Workflow
1. Confirm the repository root and the target resource type.
2. Choose repo `.forge` for repository-shared content; use global/profile paths for user- or profile-specific content.
3. Keep passive resources as plain markdown or skill files.
4. Treat executable resources as trust-gated:
   - no secrets, credentials, or runtime state
   - smoke tools should be deterministic and harmless
   - if a Forge extension rewrites shell commands, quote or escape injected text before it reaches `bash`
   - list repo Pi extensions explicitly in `.forge/pi/settings.json` so loading stays deterministic
5. If the work is mostly skill scaffolding or validation, hand that part to the existing `create-skill` skill and its scripts.
6. Make the change as small as possible, then validate the file set in a fresh-session mindset.

## Layout
See `references/layouts.md` for the quick path cheat sheet. In short:
- `.forge/skills/` for repository skills
- `.forge/specialists/` for repository specialist markdown
- `.forge/reference/` for passive repository context
- `.forge/project-agents/<definitionId>/config.json`, `prompt.md` role instructions, and optional `reference/*.md` for repository Project Agent definitions
- `.forge/extensions/` for trust-gated Forge extensions
- `.forge/pi/extensions/` and `.forge/pi/settings.json` for trust-gated Pi extensions and package config

## Safety notes
- Repository skills, specialists, reference docs, and Project Agent definition files are passive text.
- Repository Project Agent `prompt.md` contains role instructions layered with Forge's Project Agent base prompt, and `prompt.md` / `reference/*.md` are read live while the source is valid; missing/invalid sources leave the backing session/history intact but make live fields unavailable.
- Project Agent capabilities are approved at activation from `config.json`; later repo edits do not silently grant capabilities. Re-activate or link again to change approvals.
- Deactivating/unlinking a repository Project Agent clears the session's source link only. It does not edit repo files or delete session history.
- Forge/Pi extensions and Pi settings can execute code, so review them before trusting.
- Keep `.forge` resources free of secrets.

## Guardrails
- Keep executable smoke tools deterministic and harmless.
- Quote or escape rewritten shell text before it reaches `bash`.
- List repo Pi extensions explicitly in `.forge/pi/settings.json`.

## Output
- Note the target paths changed.
- Call out whether the resource is passive or trust-gated.
- Mention any remaining trust or scope questions.

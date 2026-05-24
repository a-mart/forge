# Repo `.forge` layout cheat sheet

Use repo `.forge` when the resource should ship with one repository. Use global paths under `~/.forge/...` for cross-repo personal defaults, and profile paths under `~/.forge/profiles/<profileId>/...` for one Forge profile.

## Common paths

```text
<repo>/.forge/skills/<skill-name>/SKILL.md
<repo>/.forge/specialists/<specialist-name>.md
<repo>/.forge/reference/<topic>.md
<repo>/.forge/project-agents/<definitionId>/config.json
<repo>/.forge/project-agents/<definitionId>/prompt.md
<repo>/.forge/project-agents/<definitionId>/reference/<topic>.md
<repo>/.forge/extensions/<extension-name>/index.ts
<repo>/.forge/pi/extensions/<extension-name>/index.ts
<repo>/.forge/pi/settings.json
```

## Examples

- Skill: `<repo>/.forge/skills/review-the-diff/SKILL.md`
- Specialist: `<repo>/.forge/specialists/backend.md`
- Reference doc: `<repo>/.forge/reference/project-setup.md`
- Repository Project Agent: `<repo>/.forge/project-agents/docs/config.json`, `prompt.md` role instructions, optional `reference/*.md`
- Forge extension: `<repo>/.forge/extensions/command-guard/index.ts`
- Pi extension: `<repo>/.forge/pi/extensions/smoke-tool/index.ts`
- Pi settings: `<repo>/.forge/pi/settings.json` with repo extension paths listed explicitly

Example:

```json
{
  "extensions": ["./extensions/my-tool.ts"]
}
```

## Safety reminders

- Passive resources are skills, specialists, reference docs, and repository Project Agent definition files.
- Executable resources are Forge extensions, Pi extensions, and Pi settings files they load.
- Keep executable test tools harmless and deterministic.
- Do not store secrets in `.forge`.
- Repository Project Agent `prompt.md` contains role instructions layered with Forge's Project Agent base prompt, and `prompt.md` / `reference/*.md` are live read-only repo inputs while the source is valid.
- Capabilities are approved at activation from `config.json`; re-activate/link again to change approved capabilities.
- Unlinking a repository Project Agent clears the session source link only and preserves session history and repo files.

# Repo `.forge` layout cheat sheet

Use repo `.forge` when the resource should ship with one repository. Use global paths under `~/.forge/...` for cross-repo personal defaults, and profile paths under `~/.forge/profiles/<profileId>/...` for one Forge profile.

## Common paths

```text
<repo>/.forge/skills/<skill-name>/SKILL.md
<repo>/.forge/specialists/<specialist-name>.md
<repo>/.forge/reference/<topic>.md
<repo>/.forge/extensions/<extension-name>/index.ts
<repo>/.forge/pi/extensions/<extension-name>/index.ts
<repo>/.forge/pi/settings.json
```

## Examples

- Skill: `<repo>/.forge/skills/review-the-diff/SKILL.md`
- Specialist: `<repo>/.forge/specialists/backend.md`
- Reference doc: `<repo>/.forge/reference/project-setup.md`
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

- Passive resources are skills, specialists, and reference docs.
- Executable resources are Forge extensions, Pi extensions, and Pi settings files they load.
- Keep executable test tools harmless and deterministic.
- Do not store secrets in `.forge`.
- Project agents are related, but they live in profile/session storage, not repo `.forge`.

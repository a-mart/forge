# Project Resources (`.forge`)

Forge can load project-scoped resources from a repository-root `.forge/` directory. This keeps project guidance, reference material, and optional executable automation with the repository while user state stays in `FORGE_DATA_DIR`.

For a concise authoring workflow, see the built-in `forge-project-resources` skill.

Project resources are resolved from the nearest Git root for the selected session working directory. If no Git root is found, Forge does not ancestor-walk for `.forge/` resources. A profile can optionally override the resolved project-resource directory, but the override target must be an existing directory named exactly `.forge`.

For a local Builder project, open **Project Settings → Repository resources** from the project header to inspect the detected Git root and effective `.forge` directory. The page inventories passive and executable resources, shows executable trust state, and lets you trust, block, reset, or change the project/repository-scoped `.forge` override. Passive resources remain visible when executable resources are blocked. Repository resources are not a top-level Settings tab, and this project-scoped page is unavailable for Cortex and Remote Projects.

## Layout

```text
<repo>/.forge/
  skills/                  # Repository skills, file-backed skill directories
  specialists/             # Repository specialist markdown definitions
  reference/               # Repository reference docs inventoried in prompt and read on demand
  project-agents/          # Repository Project Agent definitions
    <definitionId>/
      config.json          # handle, whenToUse, optional capabilities/model recommendation
      prompt.md            # live role instructions layered with Forge's Project Agent base prompt
      reference/*.md       # optional read-only reference docs for that agent
  extensions/              # Forge-native executable extensions, trust-gated
  pi/
    extensions/            # Pi-native executable extensions, trust-gated
    settings.json          # Pi packages/extensions config, trust-gated
```

Passive resources are available without an executable trust grant:

- `skills/` for repository skills.
- `specialists/` for repository specialist definitions.
- `reference/` for repository reference docs. They are inventoried in prompt assembly and read on demand, not injected as one full blob of context.
- `project-agents/` for repository Project Agent definitions. Activating a definition creates or links a normal session, then stores only a source link in Forge data. The session/history stay local and are not written back to the repository.

Repository Project Agent definition layout:

```text
<repo>/.forge/project-agents/<definitionId>/
  config.json       # version: 1, handle, whenToUse, optional displayName/capabilities/model
  prompt.md         # required role instructions, read live from the repo while the source is valid
  reference/*.md    # optional per-agent reference docs, read-only in the UI
```

`prompt.md` contains Project Agent role instructions layered with Forge's Project Agent base prompt. `prompt.md` and `reference/*.md` are live repo-backed inputs: changing them on a branch updates future prompt assembly after runtime refresh. `whenToUse` is read from `config.json` when the source is valid. Valid repo-defined Project Agent definitions surface in the sidebar as inactive/repo-defined rows and activate through the Repository Resources flow. Requested capabilities in `config.json` are approval-time only: Forge requires explicit approval during activation, stores the approved capability set on the session, and does not silently grant newly added capabilities from later repo edits. Re-activate or link again to change approved capabilities.

If the source definition is missing, invalid, or points at a different workspace/branch, Forge keeps the backing session and history but marks the source unhealthy. Live read-only fields are unavailable rather than using stale descriptor text. Use the settings/sidebar action to **Deactivate repository Project Agent** / **Unlink from repository definition** to clear the session's repository Project Agent link without deleting the session, history, or repository files.

Executable resources are blocked until trusted:

- `.forge/extensions/`
- `.forge/pi/extensions/`
- `.forge/pi/settings.json`, including local package extension files it references

Keep executable test fixtures deterministic and harmless. If a Forge extension rewrites shell commands, quote or escape injected output before it reaches `bash`.

Legacy exact-CWD executable surfaces (`<cwd>/.forge/extensions/`, `<cwd>/.pi/extensions/`, and `<cwd>/.pi/settings.json`) are compatibility-only. Repo-root `.forge` trust does not automatically trust separate exact-CWD legacy paths; they are active only when the legacy path is inside or identical to the selected trusted `.forge` directory. New repositories should prefer the repo-root `.forge/` layout above.

## Trust prompt behavior

When Forge detects executable project resources, it asks whether to trust them.

- **Trust** enables executable project resources for sessions in that profile/workspace.
- **Block** keeps executable project resources disabled. Passive resources remain available.
- **Manage later** dismisses the prompt for the current executable signature. The prompt appears again if executable files, package extension files, or executable metadata change.

Trust and block decisions are stored locally in Forge data, keyed by the normalized real path of the selected `.forge` directory. The key is path-only; it is not based on Git remotes, commit IDs, or repository names.

Changing trust, block, or the selected `.forge` override immediately evicts affected manager and worker runtimes so stale executable code cannot remain loaded. If a manager is active, Forge detaches and restarts the runtime without terminating the session.

## Security notes

Executable project resources run local code with your user permissions. They can read and write files, run commands, and call external services. Only trust `.forge` resources from repositories you control or have reviewed.

Denying trust disables executable resources only. Repository skills, specialists, and reference docs are still passive text resources and remain usable. Symlinked `.forge/reference` roots are skipped so reference inventories and prompt loading do not follow a repository-owned link out to another tree.

Pi package discovery for trusted `.forge/pi/settings.json` follows Pi's local package extension behavior closely enough for Settings discovery and trust signatures: package manifest entries can point at files, directories, or glob matches; directory entries support package manifests and `index.ts` / `index.js`; object-form `extensions` filters support include/exclude patterns such as `*.ts` and `!legacy.ts`. Local file package sources are loaded even when object filters are empty or exclude the file, matching Pi behavior. Forge also injects a project-scope `extensions: ["!*"]` baseline before trusted repo settings so Pi does not auto-discover legacy `<cwd>/.pi/extensions` by default. For deterministic smoke tests or custom tools, list repo Pi extensions explicitly in `.forge/pi/settings.json`, for example:

```json
{
  "extensions": ["./extensions/my-tool.ts"]
}
```

You can also list packages explicitly when the repo uses package manifests. This keeps loading deterministic under trust gating.

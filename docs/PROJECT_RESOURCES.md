# Project Resources (`.forge`)

Forge can load project-scoped resources from a repository-root `.forge/` directory. This keeps project guidance, reference material, and optional executable automation with the repository while user state stays in `FORGE_DATA_DIR`.

Project resources are resolved from the nearest Git root for the selected session working directory. If no Git root is found, Forge does not ancestor-walk for `.forge/` resources. A profile can optionally override the resolved project-resource directory, but the override target must be an existing directory named exactly `.forge`.

## Layout

```text
<repo>/.forge/
  skills/                  # Project skills, file-backed skill directories
  specialists/             # Project specialist markdown definitions
  reference/               # Project reference docs injected as repository context
  extensions/              # Forge-native executable extensions, trust-gated
  pi/
    extensions/            # Pi-native executable extensions, trust-gated
    settings.json          # Pi packages/extensions config, trust-gated
```

Passive resources are available without an executable trust grant:

- `skills/` for repository/project skills.
- `specialists/` for project specialist definitions.
- `reference/` for repository reference docs.

Executable resources are blocked until trusted:

- `.forge/extensions/`
- `.forge/pi/extensions/`
- `.forge/pi/settings.json`, including local package extension files it references

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

Pi package discovery for trusted `.forge/pi/settings.json` follows Pi's local package extension behavior closely enough for Settings discovery and trust signatures: package manifest entries can point at files, directories, or glob matches; directory entries support package manifests and `index.ts` / `index.js`; object-form `extensions` filters support include/exclude patterns such as `*.ts` and `!legacy.ts`. Local file package sources are loaded even when object filters are empty or exclude the file, matching Pi behavior. Forge also injects a project-scope `extensions: ["!*"]` baseline before trusted repo settings so Pi does not auto-discover legacy `<cwd>/.pi/extensions` by default.

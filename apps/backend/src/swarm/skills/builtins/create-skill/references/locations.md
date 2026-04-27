# Skill locations

Choose the narrowest scope that matches the request.

## Preferred targets

- **Machine-local**: `${SWARM_DATA_DIR}/skills/<name>`
  - Best for station-specific workflows that should follow the user across projects.
- **Profile**: `${SWARM_DATA_DIR}/profiles/<profileId>/pi/skills/<name>`
  - Best when the behavior belongs to one Forge profile only.
- **Project-local**: `<cwd>/.pi/skills/<name>`
  - Best when the skill should travel with one repository or worktree.
  - Warn that project-local skills may be visible to git unless `.pi/` is ignored.

## Selection rule

Use this order of preference:
1. If the skill is clearly repo-specific, choose project-local.
2. If it is profile-specific but not repo-specific, choose profile.
3. Otherwise default to machine-local.

## Naming

- Prefer lowercase kebab-case directory names.
- Keep the frontmatter `name` aligned with the directory name unless there is a strong reason not to.
- Avoid spaces and ambiguous abbreviations.

## Small legacy note

Some repo code and tests still reference a repo-level `.swarm/skills` layer for compatibility and overrides. Do not target that path for new skills unless the task is specifically about that compatibility behavior.

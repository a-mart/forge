# Skill locations

Choose the narrowest scope that matches the request.

## Supported targets

- **Global skills**
  - Best for station-specific workflows that should follow the user across all Forge projects.
- **Project skills**
  - Best when the behavior belongs to one Forge profile only.
  - Stored under `~/.forge/profiles/<profileId>/pi/skills`.
- **Repository skills**
  - Best when the skill should travel with one repository.
  - Stored under `<repo>/.forge/skills`, checked in with the repo, and discovered for sessions using that repo.
  - Scaffold with `--scope repo --repo-root <git-repo-root>`; the helper rejects non-Git directories and nested subdirectories.

## Selection rule

Use this order of preference:
1. If the skill belongs to one repository, choose repo scope (`--scope repo`).
2. If the skill belongs to one Forge profile, choose project scope (`--scope project`).
3. Otherwise default to global scope (`--scope global`).

Repository skills are normal file-backed resources, not runtime state or secrets. They participate in the same skill discovery and conflict rules as other loaded skills.

## Naming

- Prefer lowercase kebab-case directory names.
- Keep the frontmatter `name` aligned with the directory name unless there is a strong reason not to.
- Avoid spaces and ambiguous abbreviations.


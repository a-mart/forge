# Skill locations

Choose the narrowest scope that matches the request.

## Supported targets

- **Global skills**
  - Best for station-specific workflows that should follow the user across all Forge projects.
- **Project skills**
  - Best when the behavior belongs to one Forge project only.

## Selection rule

Use this order of preference:
1. If the skill belongs to one Forge project, choose project scope (`--scope project`).
2. Otherwise default to global scope (`--scope global`).

## Naming

- Prefer lowercase kebab-case directory names.
- Keep the frontmatter `name` aligned with the directory name unless there is a strong reason not to.
- Avoid spaces and ambiguous abbreviations.


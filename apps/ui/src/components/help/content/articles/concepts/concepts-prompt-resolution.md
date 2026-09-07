Forge combines a base behavioral prompt with the current work mode, specialists, project instructions, memory, skills, and runtime guidance. Understanding which parts replace the base and which add context helps keep customizations predictable.

## Base prompt lookup

Archetype and operational templates are resolved in order:

1. **Profile override** — a template saved for the selected profile.
2. **Repo template** — the matching template supplied by the repository.
3. **Builtin default** — the template shipped with Forge.

A matching override replaces that template. An ordinary manager can also have a session-specific system prompt that replaces its archetype template. Forge still assembles the applicable work mode, specialist roster, and other runtime resources around the chosen base.

Project Agents use Forge's shared base plus their authored role instructions. Optional model-specific instructions are user-authored; Forge does not add hidden model-family prompt defaults.

## Project instructions and resources

Repository instructions such as `AGENTS.md` are additional project context, separate from base-template lookup. Forge discovers applicable files from parent directories down to the working directory. In a directory containing both `AGENTS.md` and `CLAUDE.md`, `AGENTS.md` takes precedence.

Memory, skills, reference material, and current runtime guidance add further context. Task notes preserve ongoing work across context windows; they are separate from durable memory and do not replace current instructions or permissions.

## Keeping and updating customizations

A Forge update does not overwrite saved custom prompts. To adopt a new builtin template, clear the applicable override so resolution can fall back to the repository or builtin template. If another override still applies, it remains in effect. Changes take effect when the prompt is next assembled; updating a template does not forcibly restart running work.

Browse and edit templates in **Settings → Prompts**. Use a focused project instruction for repository conventions, and a base-template replacement when you intend to change the agent's broader behavior.

## Prompt inspection

**Settings → Prompts → Preview** shows the resolved prompt resources and their sources, including applicable inherited project instructions. It is a resource preview, not the exact request for a current model turn: provider formatting, live tool guidance, and transient context may differ.

The **Initial Model Input** viewer in the wide chat header's **All** view shows the retained provider-independent context for the session's first Pi request. Its **Prompt** view labels sources and renders tool definitions; **Raw JSON** shows the complete captured record. This is historical evidence of the first request, not a live view of later prompts.

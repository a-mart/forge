# In-app help context

## Content layout

Article bodies live as Markdown under `content/articles/<category>/<article-id>.md`. Article metadata
stays in the owning `content/*-articles.ts` module with an explicit `?raw` import. Do not place article
bodies in TypeScript template literals or add frontmatter.

When adding or editing an article:

1. Edit the Markdown body.
2. Update the matching metadata and `?raw` import.
3. Keep IDs, related IDs, context keys, summaries, and category ownership internally consistent.
4. Run `pnpm help:validate` from the repository root.
5. Run the routed UI check with `pnpm quality:quick` or `pnpm quality:changed` as appropriate.

`pnpm help:validate:migration` and `.internal/help-content-baseline.json` are for one-time migration
fidelity work only. Do not regenerate or require the migration baseline for normal authoring.

## Component changes

Keep the help registry, provider, search, drawer, and article rendering responsibilities separated.
When changing registration or lookup behavior, add focused coverage for metadata validation, context
routing, and rendered article selection.

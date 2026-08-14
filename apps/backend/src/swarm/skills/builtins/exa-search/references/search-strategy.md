# Search strategy

Read this reference when a request has multiple evidence axes, asks for a landscape or comparison, or leaves the source type, scope, or query shape unclear. The parent `SKILL.md` owns provider routing, CLI behavior, limits, guardrails, recovery, and output; this file only expands query planning.

## Build a semantic query

Write a short natural-language description of the desired source, not a keyword bag. Combine:

- **Subject:** a named product, organization, person, standard, or event.
- **Relationship or question:** what changed, how it works, comparison, cause, requirement, or criticism.
- **Context:** version, market, geography, audience, time window, or use case.
- **Evidence shape:** official documentation, paper, announcement, independent reporting, or user experience.

Prefer a query that names the product, version, concept, and task over a broad category. For example, use `OpenTelemetry JavaScript SDK OTLP exporter configuration` rather than `telemetry exporter`.

Keep the query and source type aligned: a search for opinions cannot establish prevalence, and a vendor announcement cannot independently establish a competitor comparison.

## Decompose compound requests

Do not expect one result set to answer every part of a compound request. Search each evidence axis independently, then compare what the sources actually support:

| Evidence axis | Example query shape |
| --- | --- |
| Capability | `database migration tool rollback support` |
| Primary guidance | `database migration tool rollback official documentation` |
| Current development | `database migration tool release announcement 2026` |
| Experience or risk | `database migration tool rollback production issues practitioner` |

Use the narrowest useful relationship in each query. Add a product/version, organization, geography, or time boundary only when it changes the evidence target. Treat a broad keyword list as a signal to split the question, not as a reason to add more keywords to one search.

## Scenario patterns

### Official technical documentation

Name the product, version, API or concept, and task. Request the primary documentation source when the answer depends on implementation details. Exact wording or a page that must be extracted belongs with `brave-search` after discovery.

### Current facts or news

Name the entity, event, and region. Add a date boundary only when recency is material. Use Exa when the task needs semantic discovery across sources; route an explicit country or freshness filter to `brave-search`, then corroborate important claims with a primary or independent source.

### Broad landscape research

Start with the unfiltered concept and use enough results to expose different source domains. Decompose the follow-up by capability, adoption, risks, and alternatives. Compare independent domains rather than accepting one result cluster, and run a separate unfiltered corroboration search if an earlier search used a restrictive domain filter.

### Social or user sentiment

Query the product plus the concrete scenario, such as user experience, migration problems, or a named failure mode. Search platforms or communities separately when needed, label anecdotes as anecdotes, and never infer market-wide sentiment from a small result set.

## Evaluate the plan

Before relying on results, check that each query has a clear evidence target, the requested source type can support the claim, and the planned sources are independent enough for the stakes. If a query still mixes unrelated concepts, split it again rather than compensating with a larger result count.

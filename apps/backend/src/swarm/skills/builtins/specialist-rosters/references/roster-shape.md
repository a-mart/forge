# Specialist roster shape

Proposal files contain one complete roster. The helper adds and maintains `revision`.

```json
{
  "rosterId": "focused-development",
  "name": "Focused Development",
  "description": "A compact development team for ordinary product work.",
  "defaultRouteId": "builder",
  "modeRoutes": {
    "general": "builder",
    "plan": "planner",
    "correctness-review": "reviewer",
    "design-review": "reviewer",
    "research": "researcher"
  },
  "routes": [
    {
      "routeId": "builder",
      "label": "Builder",
      "behaviorMode": "general",
      "useWhen": "Use for ordinary implementation with a clear outcome and acceptance criteria.",
      "avoidWhen": "Avoid when the work primarily needs planning, research, or independent review.",
      "provider": "provider-id",
      "modelId": "model-id",
      "reasoningLevel": "high",
      "availabilityFallback": {
        "provider": "fallback-provider-id",
        "modelId": "fallback-model-id",
        "reasoningLevel": "high"
      },
      "capabilityEscalationRouteId": "deep-specialist"
    }
  ]
}
```

## Fields

- `rosterId`: stable lowercase identifier using letters, digits, and hyphens.
- `name`: user-facing roster name.
- `description`: optional concise purpose or tradeoff.
- `defaultRouteId`: fallback specialist when a task has no explicit mapping.
- `modeRoutes`: optional defaults for the five task types. Every referenced route must exist.
- `routes`: one or more complete specialists with unique `routeId` values.

Task types are:

- `general` — build, execute, debug, and other outcome-focused work.
- `plan` — decomposition, sequencing, and risk analysis without implementation.
- `correctness-review` — bugs, regressions, security, edge cases, and contract validation.
- `design-review` — architecture, maintainability, API design, and consistency.
- `research` — source-backed investigation, lookup, and synthesis.

Each specialist requires `routeId`, `label`, `useWhen`, `provider`, `modelId`, and `reasoningLevel`. `behaviorMode`, `avoidWhen`, `color`, `availabilityFallback`, and `capabilityEscalationRouteId` are optional. Include `behaviorMode` when the specialist has a normal task contract even if it is selected manually.

Use `models` to obtain the current provider IDs, model IDs, default reasoning, and supported reasoning levels. The Settings API rejects unavailable models, unknown task mappings, missing escalation targets, self-escalation, and escalation cycles.

Availability fallback continues the same attempt on another model only when the primary model is unavailable. Capability escalation starts a fresh attempt on another specialist after evidence that the original specialist could not handle the work. Neither mechanism is required.

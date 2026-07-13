# UI application context

## Boundaries

`apps/ui` is the TanStack Start/Vite React application. Keep transport and server-state ownership in
the established client/store layers; feature components should consume those layers instead of opening
sockets or creating parallel global state.

Shared protocol types come from `@forge/protocol`. Do not redefine backend DTOs in UI modules.

## Components and state

- Use existing shadcn/Radix primitives from `src/components/ui/` for shared controls before creating a
  new primitive. Add shadcn components from `apps/ui`, where `components.json` lives, with
  `pnpm dlx shadcn@latest add <component-name>`.
- Keep top-level feature components as stable composition surfaces and extract focused components and
  hooks into the nearest existing subdirectory.
- Prefer local state and focused hooks. Do not introduce a new state library for a feature without an
  explicit architectural need.
- Preserve origin scoping for remote-project state. An event from one origin must not update or
  rerender another origin's subscribers.
- Preserve desktop and mobile behavior intentionally; do not assume hover, wide viewports, or a
  filesystem-capable client.

## Validation

Run the focused component/hook test for changed behavior. For event-driven UI, validate both live
WebSocket handling and initial/replayed state when applicable. For shared component or store changes,
audit all consumers rather than relying only on the edited feature's test.

Deeper instructions apply in `src/components/chat/AGENTS.md`, `src/components/settings/AGENTS.md`,
`src/components/help/AGENTS.md`, and `src/lib/AGENTS.md`.

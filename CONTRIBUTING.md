# Contributing to Forge

Thanks for your interest in contributing! We welcome bug fixes, docs improvements, tests, and new features.

## Prerequisites

- Node.js 22+
- pnpm 10.30+

## Setup

```bash
git clone https://github.com/radopsai/middleman.git
cd middleman
pnpm install
cp .env.example .env
pnpm dev
```

## Development Ports

- Backend (HTTP + WS): `http://127.0.0.1:47187`
- UI: `http://127.0.0.1:47188`

## Code Standards

- TypeScript is the project standard.
- Keep backend/frontend contracts in sync (`packages/protocol`).
- Run typechecks before submitting:

```bash
cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit
cd apps/ui && pnpm exec tsc --noEmit
```

## Testing

Run full test suites:

```bash
pnpm test
```

Run an individual test file:

```bash
pnpm exec vitest run path/to/file
```

## UI Components

Use **shadcn/ui** for shared UI primitives.

Run the shadcn CLI from `apps/ui/`:

```bash
cd apps/ui
pnpm dlx shadcn@latest add <component-name>
```

## Pull Request Process

1. Fork the repository
2. Create a branch for your change
3. Open a PR against `main`
4. Ensure tests and typechecks pass

Thanks for helping improve Forge!

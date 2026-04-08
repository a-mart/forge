# WebSocket backend context

## Structure

- HTTP routes live in `ws/http/routes/`.
- WS commands live in `ws/commands/`.
- HTTP services live in `ws/http/services/`.
- Shared HTTP helpers live in `ws/http/shared/`.

## Composition root

`ws/server.ts` is the wiring point. It assembles the HTTP server, websocket server, route bundles, services, and subscriptions.

## Command flow

Client messages flow through:

`ws-handler` -> `ws-command-parser` -> domain parsers -> command handlers

Keep parsing and execution separated so the handler layer stays thin and the per-domain parsers own validation.

## Import rules

- Route code should not reach directly into `swarm/` internals.
- Use `SwarmManager` as the boundary when websocket or HTTP work needs swarm behavior.
- Shared helpers belong in `ws/http/shared/` or the relevant command/service module, not in route handlers.

## Compatibility shims

The legacy `ws/routes/` tree is a re-export layer for the newer `ws/http/routes/` and `ws/http/services/` locations. Keep those shims intact until all consumers move.

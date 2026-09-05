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

## Opt-in local Builder inventory

`subscribe_inventory` is parsed by the utility domain parser. It requires a nonempty bounded
`requestId` (128 characters) and rejects extra fields such as a conversation target or options.

- Capability is local Builder only. A `collaboration-server` runtime, including Remote Projects and
  an authenticated admin, rejects the command with `INVENTORY_NOT_SUPPORTED` before inventory state
  is installed.
- An old server without the command fails closed with `INVALID_COMMAND` (`Unknown command type`).
  Do not recover that rejection, a timeout, or a malformed inventory command by sending ordinary
  `subscribe`.
- Explicit conversation `subscribe` remains supported. Inventory and conversation subscriptions are
  distinct targets on the existing owner. Viewer, presence, last-seen, session, terminal, and
  conversation lookup paths use conversation-only accessors.
- Installing or refreshing inventory must not resolve or hydrate a default conversation, read
  transcript, mark read, or record a viewer. Unattended unread continues to increment while only
  inventory is connected.
- The correlated `inventory_snapshot` is the complete baseline and the positive capability
  acknowledgement. `inventory_pong` is liveness only and is not a capability acknowledgement.
- On an inventory socket, `ping` replies with `inventory_pong`. Ordinary conversation `ping` still
  replies with `ready` and a viewed `subscribedAgentId`. Preserve those legacy semantics.
- Inventory sockets may run only the allowlisted origin-safe or explicitly addressed actions in
  `isInventoryCommandAllowed`. When a handler needs a manager caller, the preferred or configured
  manager is command authority only and is never recorded as a viewing subscription. Implicit
  user-message, merge-memory, goal/choice, browser, terminal, transcript, and generic proxy
  authority stay denied (`NOT_SUBSCRIBED`).
- Demoting inventory to explicit `subscribe` restores conversation semantics, including mark-read
  for the requested session. Demoting a conversation socket to inventory must not mark anything
  read.

## Import rules

- Route code should not reach directly into `swarm/` internals.
- Use `SwarmManager` as the boundary when websocket or HTTP work needs swarm behavior.
- Shared helpers belong in `ws/http/shared/` or the relevant command/service module, not in route handlers.
- Builder-only adapters such as local Git Monitoring and Stream Deck pairing belong behind focused HTTP services/routes. Do not compose them for Collaboration or Remote Projects.

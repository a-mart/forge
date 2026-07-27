# Forge Command Center for Stream Deck

Forge Command Center is a native Stream Deck SDK v3 plugin backed by Forge's authenticated
Stream Deck API. It turns Stream Deck and Stream Deck XL into a live control surface for sessions, questions,
workers, context, repository activity, navigation, and guarded agent actions.

## Connect it

Released Forge Desktop builds bundle the direct-distribution installer.

1. Open **Forge Settings → Stream Deck** and choose **Install / Update**.
2. Confirm the native plugin installation in Stream Deck. Forge's device-specific layout is
   installed automatically.
3. Stream Deck displays a six-digit pairing code across the Forge keys.
4. Approve the matching request in **Forge Settings → Stream Deck**.

Forge gives each device a dedicated, revocable credential scoped to snapshot reads and Stream
Deck actions. The plaintext credential is delivered to the plugin exactly once and Forge persists
only its hash. It cannot authenticate the Forge CLI. Connection URLs remain available as advanced
property-inspector settings for development and non-default local instances.

## XL command-center layout

| Row | Keys |
| --- | --- |
| 1 | Forge Pulse, Attention Beacon, six attention-ranked recent sessions |
| 2 | Worker Radar, Context Core, tokens, cache, commits, lines added, two more recent sessions |
| 3 | Source Control, Automatic Browser, Terminal, Statistics, Tokens, Chat, New Session, Status Mission |
| 4 | Ship Check Mission, Stop/Resume, Smart Compact, Mark Read |

Only unresolved choice requests animate; normal running, unread, worker, and statistic states remain
still and glanceable. Sessions are ranked by
pending choice, error, unread output, active work, then recency. Controls that can change session
state require a 650 ms hold. Delete and clear operations are intentionally not exposed.

## Development

```bash
pnpm streamdeck:build
pnpm streamdeck:validate
pnpm --filter @forge/stream-deck run link
pnpm streamdeck:pack
```

The packaged artifact is written to
`apps/stream-deck/com.forge.command-center.streamDeckPlugin`.

The backend endpoints are builder-only. Pairing bootstrap and claim routes are local-only and
require an explicit approval through the local Forge Settings surface:

- `POST /api/stream-deck/pairing/requests`
- `POST /api/stream-deck/pairing/requests/:requestId/claim`
- `GET /api/stream-deck/snapshot`
- `POST /api/stream-deck/actions`

The snapshot/action routes accept the dedicated device token. CLI keys remain supported as a
temporary compatibility seam for existing development installations. Shared request and response
contracts live in `packages/protocol/src/stream-deck.ts`.

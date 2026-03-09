# Playwright Dashboard Backend Architecture Research

## Executive summary

Middleman’s backend is a plain Node HTTP + WebSocket server with manual route registration, a strongly typed WebSocket event contract in `packages/protocol`, and a central `SwarmManager` that owns the agent registry/runtime state. Long-lived peripheral services are **not** embedded into `SwarmManager` by default; the current pattern is:

- `SwarmManager` owns core swarm/runtime/persistence concerns.
- `apps/backend/src/index.ts` instantiates additional long-lived services (`IntegrationRegistryService`, `CronSchedulerService`) and wires them into the server.
- `apps/backend/src/ws/server.ts` registers HTTP route bundles and forwards selected events to `WsHandler`.
- `apps/backend/src/ws/ws-handler.ts` handles socket subscriptions, command dispatch, and event fanout/bootstrap.

For a new Playwright discovery feature, the cleanest fit is:

1. Add a new long-lived `PlaywrightDiscoveryService` in `apps/backend/src/playwright/`.
2. Instantiate it in `apps/backend/src/index.ts` after `swarmManager.boot()`.
3. Inject it into `SwarmWebSocketServer`.
4. Add a new route bundle `apps/backend/src/ws/routes/playwright-routes.ts` and register it in `apps/backend/src/ws/server.ts`.
5. Add new `ServerEvent` types in `packages/protocol/src/server-events.ts` (plus exported shared types).
6. Update `apps/backend/src/ws/ws-handler.ts` so new clients receive an initial Playwright snapshot and live updates.
7. Add a dedicated persisted settings store for the toggle; **do not** try to shoehorn this into existing settings env/auth storage.

---

## Files reviewed

### Core HTTP / WS server
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/ws/http-utils.ts`
- `apps/backend/src/ws/routes/http-route.ts`

### All HTTP route bundles
- `apps/backend/src/ws/routes/agent-routes.ts`
- `apps/backend/src/ws/routes/conversation-routes.ts`
- `apps/backend/src/ws/routes/cortex-routes.ts`
- `apps/backend/src/ws/routes/feedback-routes.ts`
- `apps/backend/src/ws/routes/file-routes.ts`
- `apps/backend/src/ws/routes/health-routes.ts`
- `apps/backend/src/ws/routes/integration-routes.ts`
- `apps/backend/src/ws/routes/manager-routes.ts`
- `apps/backend/src/ws/routes/scheduler-routes.ts`
- `apps/backend/src/ws/routes/session-routes.ts`
- `apps/backend/src/ws/routes/settings-routes.ts`
- `apps/backend/src/ws/routes/transcription-routes.ts`

### Swarm / persistence / data model
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `apps/backend/src/swarm/persistence-service.ts`
- `apps/backend/src/swarm/data-migration.ts`
- `apps/backend/src/swarm/session-manifest.ts`
- `apps/backend/src/swarm/cwd-policy.ts`
- `apps/backend/src/swarm/secrets-env-service.ts`
- `apps/backend/src/swarm/skill-metadata-service.ts`

### Startup / config / service patterns
- `apps/backend/src/index.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/integrations/registry.ts`
- `apps/backend/src/integrations/telegram/telegram-polling-pool.ts`
- `apps/backend/src/integrations/telegram/telegram-polling.ts`

### Shared protocol
- `packages/protocol/src/index.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/client-commands.ts`
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/attachments.ts`
- `packages/protocol/src/feedback.ts`

### Frontend consumer touchpoint noted for event integration
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/components/settings/settings-api.ts`

---

## 1. HTTP server and route registration

## Relevant files
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/routes/http-route.ts`
- `apps/backend/src/ws/http-utils.ts`
- every file in `apps/backend/src/ws/routes/`

## How routes are defined

Routes are simple objects implementing:

```ts
export interface HttpRoute {
  readonly methods: string;
  matches: (pathname: string) => boolean;
  handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void>;
}
```

Source: `apps/backend/src/ws/routes/http-route.ts`

There is no Express/Fastify/router framework. `SwarmWebSocketServer` keeps an array of `HttpRoute` objects and linearly finds the first match:

```ts
private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = resolveRequestUrl(request, `${this.host}:${this.port}`);
  const route = this.httpRoutes.find((candidate) => candidate.matches(requestUrl.pathname));

  if (!route) {
    response.statusCode = 404;
    response.end("Not Found");
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    ...
  }
}
```

Source: `apps/backend/src/ws/server.ts`

### Important implications
- Route order matters if matchers overlap.
- Each route bundle is just a function returning `HttpRoute[]`.
- CORS/method validation/body parsing are done manually inside each route.
- Some handlers fully catch/translate errors themselves; uncaught errors fall back to the generic heuristic in `server.ts`.

## How route bundles are registered

`SwarmWebSocketServer` builds `httpRoutes` in its constructor:

```ts
this.httpRoutes = [
  ...createHealthRoutes(...),
  ...createFileRoutes({ swarmManager: this.swarmManager }),
  ...createFeedbackRoutes({ swarmManager: this.swarmManager }),
  ...createCortexRoutes({ swarmManager: this.swarmManager }),
  ...createTranscriptionRoutes({ swarmManager: this.swarmManager }),
  ...createSchedulerRoutes({ swarmManager: this.swarmManager }),
  ...createAgentHttpRoutes({ swarmManager: this.swarmManager }),
  ...this.settingsRoutes.routes,
  ...createIntegrationRoutes({
    swarmManager: this.swarmManager,
    integrationRegistry: this.integrationRegistry
  })
];
```

Source: `apps/backend/src/ws/server.ts`

## Existing route patterns to follow

### Pattern A: bundle factory with only `swarmManager`
Example: `createSchedulerRoutes`

```ts
export function createSchedulerRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => MANAGER_SCHEDULES_ENDPOINT_PATTERN.test(pathname),
      handle: async (request, response, requestUrl) => {
        ...
      }
    }
  ];
}
```

### Pattern B: bundle factory with an injected service
Example: `createIntegrationRoutes`

```ts
export function createIntegrationRoutes(options: {
  swarmManager: SwarmManager;
  integrationRegistry: IntegrationRegistryService | null;
}): HttpRoute[] {
  ...
}
```

That is the right pattern for Playwright discovery because the discovery service will be long-lived and stateful.

### Pattern C: route bundle returning routes + cleanup hooks
Example: `createSettingsRoutes`

```ts
export interface SettingsRouteBundle {
  routes: HttpRoute[];
  cancelActiveSettingsAuthLoginFlows: () => void;
}
```

Only needed if the route owns active in-memory flows (SSE/OAuth). Discovery routes probably do **not** need this unless you add streaming scans.

## Recommended new route bundle

Add:

- `apps/backend/src/ws/routes/playwright-routes.ts`

Suggested signature:

```ts
export function createPlaywrightRoutes(options: {
  swarmManager: SwarmManager;
  discoveryService: PlaywrightDiscoveryService | null;
}): HttpRoute[]
```

Then register in:

- `apps/backend/src/ws/server.ts`

Example constructor change:

```ts
...createPlaywrightRoutes({
  swarmManager: this.swarmManager,
  discoveryService: this.playwrightDiscovery
}),
```

## Suggested HTTP endpoints

Recommended endpoints:

- `GET /api/playwright/sessions`
  - returns current discovery snapshot
- `POST /api/playwright/rescan`
  - triggers immediate rescan
- `GET /api/playwright/settings`
  - returns enabled state + effective source
- `PUT /api/playwright/settings`
  - updates persisted toggle

If you want to keep all settings under the existing namespace, use:
- `GET /api/settings/playwright`
- `PUT /api/settings/playwright`

That would fit the current UI mental model, but the actual discovery data should still live under `/api/playwright/*`.

## Example route shape to follow

```ts
const PLAYWRIGHT_SESSIONS_ENDPOINT_PATH = "/api/playwright/sessions";
const PLAYWRIGHT_RESCAN_ENDPOINT_PATH = "/api/playwright/rescan";

export function createPlaywrightRoutes(options: {
  swarmManager: SwarmManager;
  discoveryService: PlaywrightDiscoveryService | null;
}): HttpRoute[] {
  const { discoveryService } = options;

  return [
    {
      methods: "GET, OPTIONS",
      matches: (pathname) => pathname === PLAYWRIGHT_SESSIONS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, "GET, OPTIONS");
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, "GET, OPTIONS");
          response.setHeader("Allow", "GET, OPTIONS");
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, "GET, OPTIONS");

        if (!discoveryService) {
          sendJson(response, 501, { error: "Playwright discovery unavailable" });
          return;
        }

        sendJson(response, 200, discoveryService.getSnapshot());
      }
    }
  ];
}
```

---

## 2. WebSocket event system

## Relevant files
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`
- `apps/ui/src/lib/ws-client.ts` (consumer that must be updated for new event types)

## How events are emitted today

There are two layers:

1. `SwarmManager` / other services emit events.
2. `SwarmWebSocketServer` subscribes to those events and forwards them to `WsHandler.broadcastToSubscribed(...)`.

Example from `apps/backend/src/ws/server.ts`:

```ts
this.swarmManager.on("conversation_message", this.onConversationMessage);
this.swarmManager.on("conversation_log", this.onConversationLog);
this.swarmManager.on("agent_message", this.onAgentMessage);
this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
this.swarmManager.on("conversation_reset", this.onConversationReset);
this.swarmManager.on("agent_status", this.onAgentStatus);
this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
this.swarmManager.on("profiles_snapshot", this.onProfilesSnapshot);
this.integrationRegistry?.on("slack_status", this.onSlackStatus);
this.integrationRegistry?.on("telegram_status", this.onTelegramStatus);
```

This means adding a new service event requires **both**:
- the new service to emit it, and
- `server.ts` to subscribe/unsubscribe/forward it.

## Existing `ServerEvent` types

From `packages/protocol/src/server-events.ts`, the current union includes:

- bootstrap / conversation
  - `ready`
  - `conversation_reset`
  - `conversation_history`
  - `conversation_message`
  - `conversation_log`
  - `agent_message`
  - `agent_tool_call`
- agent/profile snapshots
  - `agent_status`
  - `agents_snapshot`
  - `profiles_snapshot`
  - `unread_notification`
- manager/session lifecycle
  - `manager_created`
  - `manager_deleted`
  - `manager_model_updated`
  - `session_created`
  - `session_stopped`
  - `session_resumed`
  - `session_deleted`
  - `session_cleared`
  - `session_renamed`
  - `session_forked`
  - `session_memory_merge_started`
  - `session_memory_merged`
  - `session_memory_merge_failed`
- misc WS command results
  - `stop_all_agents_result`
  - `directories_listed`
  - `directory_validated`
  - `directory_picked`
- integrations
  - `slack_status`
  - `telegram_status`
- generic
  - `error`

## How broadcasting is filtered

`WsHandler.broadcastToSubscribed()` is selective for some event types and global for others:

```ts
if (
  event.type === "conversation_message" ||
  event.type === "conversation_log" ||
  event.type === "agent_message" ||
  event.type === "agent_tool_call" ||
  event.type === "conversation_reset"
) {
  if (subscribedAgent !== event.agentId) {
    continue;
  }
}

if (event.type === "slack_status" || event.type === "telegram_status") {
  if (event.managerId) {
    const subscribedProfileId = this.resolveProfileIdForAgent(subscribedAgent);
    if (subscribedProfileId !== event.managerId) {
      continue;
    }
  }
}
```

Everything else is effectively broadcast to all subscribed clients.

### Implication for Playwright events
You must decide whether discovery is:
- **global** (all clients see all discovered sessions), or
- **profile-scoped** (only clients subscribed to a profile/session in that profile see those rows).

If profile-scoped, follow the Slack/Telegram pattern and add a profile ID field plus filtering logic in `ws-handler.ts`.

## Bootstrap behavior for new connections

On subscribe, `WsHandler.sendSubscriptionBootstrap()` sends:

```ts
this.send(socket, { type: "ready", ... })
this.send(socket, { type: "agents_snapshot", agents: this.swarmManager.listAgents() })
this.send(socket, { type: "profiles_snapshot", profiles: this.swarmManager.listProfiles() })
this.send(socket, {
  type: "conversation_history",
  agentId: targetAgentId,
  messages: this.swarmManager.getConversationHistory(targetAgentId)
})
```

and current integration statuses.

### Critical gotcha
If Playwright state is only sent as incremental update events, new clients will see nothing until the next scan.

So you should either:
1. send a bootstrap snapshot from `sendSubscriptionBootstrap()`, or
2. require the UI to fetch `GET /api/playwright/sessions` immediately after connect.

For a dashboard, I recommend **both**: HTTP initial load + WS live updates.

## Recommended protocol additions

Add new WS events, for example:

```ts
export interface PlaywrightDiscoverySnapshotEvent {
  type: 'playwright_discovery_snapshot'
  profileId?: string
  enabled: boolean
  updatedAt: string
  sessions: PlaywrightDiscoveredSession[]
}

export interface PlaywrightDiscoveryUpdatedEvent {
  type: 'playwright_discovery_updated'
  profileId?: string
  enabled: boolean
  updatedAt: string
  sessions: PlaywrightDiscoveredSession[]
}
```

Then extend the `ServerEvent` union in:
- `packages/protocol/src/server-events.ts`
- re-export via `packages/protocol/src/index.ts`

Then update the backend fanout in:
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`

And note the frontend consumer will also need new `case` branches in:
- `apps/ui/src/lib/ws-client.ts`

---

## 3. Service architecture: where `PlaywrightDiscoveryService` fits

## Relevant files
- `apps/backend/src/index.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/integrations/registry.ts`
- `apps/backend/src/scheduler/cron-scheduler-service.ts`

## What lives inside `SwarmManager`

`SwarmManager` owns core swarm state and several internal helper services:

```ts
private readonly conversationProjector: ConversationProjector;
private readonly persistenceService: PersistenceService;
private readonly runtimeFactory: RuntimeFactory;
private readonly skillMetadataService: SkillMetadataService;
private readonly secretsEnvService: SecretsEnvService;
```

It is itself an `EventEmitter` and is responsible for:
- agent descriptors / registry
- profile/session lifecycle
- runtime creation/restoration
- persistence to `agents.json`
- memory/session metadata
- emitting swarm-centric events (`agent_status`, `agents_snapshot`, etc.)

## What lives outside `SwarmManager`

Long-lived peripheral services are currently top-level in `apps/backend/src/index.ts`.

### Integration registry pattern

```ts
const integrationRegistry = new IntegrationRegistryService({
  swarmManager,
  dataDir: config.paths.dataDir,
  defaultManagerId: config.managerId
});
await integrationRegistry.start();
```

### Scheduler pattern

```ts
const scheduler = new CronSchedulerService({
  swarmManager,
  schedulesFile: getScheduleFilePath(config.paths.dataDir, managerId),
  managerId
});
await scheduler.start();
```

## Recommendation

`PlaywrightDiscoveryService` should be a **top-level service instantiated in `apps/backend/src/index.ts`**, not an internal helper owned by `SwarmManager`.

Why:
- discovery is not core swarm runtime logic
- it likely needs its own polling/watcher lifecycle
- it may emit UI-facing events independently of agent events
- it will need injected dependencies (`swarmManager`, config, settings store) similar to `IntegrationRegistryService`

## Suggested class shape

Recommended new files:

- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-settings-service.ts`
- `apps/backend/src/playwright/playwright-types.ts` (backend-only internals if needed)

Suggested public surface:

```ts
export class PlaywrightDiscoveryService extends EventEmitter {
  constructor(options: {
    swarmManager: SwarmManager
    dataDir: string
    config: SwarmConfig
    settingsService: PlaywrightSettingsService
    now?: () => string
    scanIntervalMs?: number
  })

  async start(): Promise<void>
  async stop(): Promise<void>

  getSnapshot(): PlaywrightDiscoverySnapshot
  isEnabled(): boolean
  getEffectiveSettings(): PlaywrightDiscoverySettingsSnapshot

  async setEnabled(enabled: boolean): Promise<PlaywrightDiscoverySettingsSnapshot>
  async triggerRescan(reason?: string): Promise<PlaywrightDiscoverySnapshot>
}
```

## Recommended startup wiring

In `apps/backend/src/index.ts`:

```ts
const playwrightSettings = new PlaywrightSettingsService({ dataDir: config.paths.dataDir })
await playwrightSettings.load()

const playwrightDiscovery = new PlaywrightDiscoveryService({
  swarmManager,
  dataDir: config.paths.dataDir,
  config,
  settingsService: playwrightSettings,
})
await playwrightDiscovery.start()

const wsServer = new SwarmWebSocketServer({
  swarmManager,
  host: config.host,
  port: config.port,
  allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
  integrationRegistry,
  playwrightDiscovery,
})
```

And on shutdown:

```ts
await Promise.allSettled([
  queueSchedulerSync(new Set<string>()),
  integrationRegistry.stop(),
  playwrightDiscovery.stop(),
  wsServer.stop()
])
```

## Recommended server wiring

`apps/backend/src/ws/server.ts` should:
- accept `playwrightDiscovery?: PlaywrightDiscoveryService`
- pass it into `createPlaywrightRoutes(...)`
- subscribe to discovery events in `start()`
- unsubscribe in `stop()`

Pattern should mirror `integrationRegistry`.

---

## 4. Config and environment loading

## Relevant files
- `apps/backend/src/index.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/secrets-env-service.ts`
- `apps/backend/src/swarm/data-paths.ts`

## How `.env` is loaded

At backend process startup:

```ts
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });
```

Source: `apps/backend/src/index.ts`

So the repo root `.env` is loaded **once**, before `createConfig()` runs.

## Current config fields

`createConfig()` reads process env into `SwarmConfig`:

```ts
return {
  host: process.env.MIDDLEMAN_HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.MIDDLEMAN_PORT ?? "47187", 10),
  debug: true,
  allowNonManagerSubscriptions: true,
  ...
}
```

Source: `apps/backend/src/config.ts`

`createConfig()` also sets important paths from `MIDDLEMAN_DATA_DIR` and derives `cwdAllowlistRoots`:

```ts
const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? resolve(homedir(), ".middleman");
...
const cwdAllowlistRoots = normalizeAllowlistRoots([
  rootDir,
  resolve(homedir(), "worktrees")
]);
```

## Data directory layout relevant to this feature

From `apps/backend/src/swarm/data-paths.ts`:

- global agent registry
  - `~/.middleman/swarm/agents.json`
- profiles root
  - `~/.middleman/profiles/<profileId>/`
- per session
  - `~/.middleman/profiles/<profileId>/sessions/<sessionAgentId>/session.jsonl`
  - `~/.middleman/profiles/<profileId>/sessions/<sessionAgentId>/meta.json`
  - `~/.middleman/profiles/<profileId>/sessions/<sessionAgentId>/workers/<workerId>.jsonl`
- shared config-ish area
  - `~/.middleman/shared/`
  - `~/.middleman/shared/auth/auth.json`
  - `~/.middleman/shared/secrets.json`
  - `~/.middleman/shared/integrations/`

## Existing settings persistence is not a generic settings store

There are only two persisted “settings” systems today:

1. secrets env values in `shared/secrets.json`
2. auth credentials in `shared/auth/auth.json`

`SecretsEnvService` persists env values like this:

```ts
private async saveSecretsStore(): Promise<void> {
  const target = this.deps.config.paths.sharedSecretsFile;
  const tmp = `${target}.tmp`;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}
```

## Important gotchas for feature flags

### Gotcha 1: config is startup-time only
If you add `playwrightDashboardEnabled` to `SwarmConfig`, that value is read at startup and won’t automatically react to later settings updates.

### Gotcha 2: `/api/settings/env` is not suitable for a boolean toggle
`settings-routes.ts` env endpoints only manage string env vars, and `listSettingsEnv()` only exposes:
- env vars declared by built-in skill frontmatter, plus
- `CODEX_API_KEY`

That means a new env var like `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED` would **not** appear in settings UI unless you extend that machinery.

### Gotcha 3: env updates mutate `process.env`, but are not part of `SwarmConfig`
`SecretsEnvService.updateSettingsEnv()` does `process.env[name] = value`, so runtime code can observe updated env vars **only if it reads `process.env` dynamically**.

## Recommendation for toggle implementation

Use **both**:

1. an env var for operator override, parsed in `createConfig()`
2. a dedicated persisted settings file for user-configurable runtime state

Suggested env var:
- `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`

Suggested persisted file:
- `~/.middleman/shared/playwright-dashboard.json`

Suggested precedence:
- if env var is explicitly set, it is authoritative
- otherwise use persisted setting
- default to `false`

That gives:
- stable deploy/operator control
- runtime UI toggling when env does not force the value

---

## 5. Agent registry and worker/session correlation

## Relevant files
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/persistence-service.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `packages/protocol/src/shared-types.ts`

## Agent descriptor model

Canonical shared shape lives in `packages/protocol/src/shared-types.ts`:

```ts
export interface AgentDescriptor {
  agentId: string
  managerId: string
  displayName: string
  role: 'manager' | 'worker'
  archetypeId?: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  cwd: string
  model: AgentModelDescriptor
  sessionFile: string
  contextUsage?: AgentContextUsage
  profileId?: string
  sessionLabel?: string
  mergedAt?: string
}
```

## How the registry is persisted

`PersistenceService.saveStore()` writes:

- `apps/backend/src/swarm/persistence-service.ts`
- target file: `config.paths.agentsStoreFile`
- actual path: `~/.middleman/swarm/agents.json`

```ts
const payload: AgentsStoreFile = {
  agents: this.deps.sortedDescriptors(),
  profiles: this.deps.sortedProfiles()
};
```

## How agents are exposed

`SwarmManager.listAgents()` returns cloned descriptors:

```ts
listAgents(): AgentDescriptor[] {
  return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
}
```

So a discovery service can safely use `swarmManager.listAgents()` or `swarmManager.getAgent(...)` for correlation.

## Manager/profile/session semantics

Important for correlation:

- Managers are actually session agents.
- Root/default session has `agentId === profileId`.
- Non-root sessions have `agentId !== profileId` but still `role === 'manager'`.
- Workers have:
  - `role === 'worker'`
  - `managerId === owning session agentId`
  - `profileId === owning profileId`

This means correlation should generally use:
- `profileId` to group under a profile
- `managerId` to attach a worker to its session
- `cwd` to connect a worker to a discovered worktree/session file

## Worker recovery on boot

A useful detail: `SwarmManager` can recover worker descriptors from on-disk worker JSONL files even if the descriptor is missing from the registry.

Source: `apps/backend/src/swarm/swarm-manager.ts`

```ts
const workersDir = getWorkersDir(this.config.paths.dataDir, profileId, descriptor.agentId);
...
const workerDescriptor: AgentDescriptor = {
  agentId: workerId,
  displayName: workerId,
  role: "worker",
  managerId: descriptor.agentId,
  profileId,
  status: "terminated",
  createdAt: header.createdAt ?? descriptor.createdAt,
  updatedAt: header.updatedAt ?? descriptor.updatedAt,
  cwd: header.cwd ?? descriptor.cwd,
  model: header.model ?? descriptor.model,
  sessionFile: workerFilePath
};
```

### Why this matters
Even after restart, correlation can still include terminated/stopped workers if their descriptor survived or was recoverable.

## What data exists today for correlation

Useful existing fields:
- `agentId`
- `role`
- `managerId`
- `profileId`
- `status`
- `cwd`
- `sessionFile`
- `model`
- `updatedAt`

## Hard limitation discovered

There is **no existing Playwright-specific metadata on agents**.

That means a discovery service cannot directly answer “this `.session` file belongs to worker X” from first-class backend data alone.

Current correlation will have to be heuristic unless you add a new persisted mapping source.

## Best available correlation strategy with current data

### Strong signals
- exact/realpath-equal worktree path to agent `cwd`
- discovered session metadata explicitly naming a worker/session id (if present in `.session` or registry file)
- socket/port env files inside the same worktree as the agent `cwd`

### Medium signals
- discovered worktree path is ancestor/descendant of worker `cwd`
- session file mtime close to worker `updatedAt`
- only one active worker exists in that worktree

### Weak signals
- matching branch/worktree folder names only

## Recommendation

Model correlation explicitly in the discovery result:

```ts
correlation: {
  matchedAgentId?: string
  matchedManagerId?: string
  matchedProfileId?: string
  confidence: 'high' | 'medium' | 'low' | 'none'
  reasons: string[]
}
```

Do not overstate certainty.

---

## 6. Existing polling / watcher / background service patterns

## Relevant files
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/integrations/registry.ts`
- `apps/backend/src/integrations/telegram/telegram-polling-pool.ts`
- `apps/backend/src/integrations/telegram/telegram-polling.ts`

## Best pattern to copy: `CronSchedulerService`

This is the closest backend pattern for a discovery scanner because it combines:
- `start()` / `stop()` lifecycle
- initial load on startup
- file watcher
- periodic polling fallback
- serialized processing to avoid overlapping runs

Key code:

```ts
async start(): Promise<void> {
  if (this.running) return;

  this.running = true;
  await this.ensureSchedulesFile();
  await this.processDueSchedules("startup");
  this.startWatcher();
  this.startPolling();
}
```

```ts
private requestProcess(reason: string): void {
  if (!this.running) return;

  if (this.processing) {
    this.pendingProcess = true;
    return;
  }

  this.processing = true;
  const run = this.processDueSchedules(reason)
    .catch(...)
    .finally(() => {
      this.processing = false;
      if (this.pendingProcess && this.running) {
        this.pendingProcess = false;
        this.requestProcess("pending");
      }
    });

  this.activeRunPromise = run.finally(() => {
    if (this.activeRunPromise === run) {
      this.activeRunPromise = undefined;
    }
  });
}
```

## Another useful pattern: `IntegrationRegistryService.runExclusive`

```ts
private async runExclusive<T>(action: () => Promise<T>): Promise<T> {
  const next = this.lifecycle.then(action, action);
  this.lifecycle = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
```

That is a good fit if your discovery service needs to serialize rescans, enable/disable toggles, and config updates.

## Telegram polling pattern

`TelegramPollingBridge` shows a clean long-lived loop with:
- `AbortController`
- start/stop state changes
- retry sleeps
- incremental updates

It is less directly applicable than `CronSchedulerService`, but useful if discovery becomes a pure polling loop rather than watcher + poll.

## Recommendation for discovery mechanics

Use the scheduler-style pattern:
- `start()` performs immediate initial scan
- `watch(...)` selected parent directories/registry files if practical
- `setInterval(...)` fallback periodic rescan
- serialize scans so only one runs at a time
- keep an in-memory last snapshot and emit only when changed

---

## 7. Settings persistence and toggle storage

## Relevant files
- `apps/backend/src/ws/routes/settings-routes.ts`
- `apps/backend/src/swarm/secrets-env-service.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `apps/ui/src/components/settings/settings-api.ts` (frontend shape consumer)

## Current settings endpoints

Today’s settings routes only cover:
- `/api/settings/env`
- `/api/settings/auth`
- `/api/settings/auth/login/...`

Source: `apps/backend/src/ws/routes/settings-routes.ts`

## How settings route handlers are structured

Example pattern:

```ts
if (request.method === "GET" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
  applyCorsHeaders(request, response, methods);
  const variables = await swarmManager.listSettingsEnv();
  sendJson(response, 200, { variables });
  return;
}
```

and methods delegate to `SwarmManager`, which delegates to `SecretsEnvService`.

## Why not extend `SecretsEnvService` for this

`SecretsEnvService` is tightly specialized for:
- secret env vars
- auth provider credentials
- masking sensitive values
- skill metadata env declarations

A Playwright dashboard enabled toggle is:
- not a secret
- not an auth credential
- not skill env metadata
- likely boolean, not string

So it should be a **separate settings service**.

## Recommended persistence location

Add a new helper in `apps/backend/src/swarm/data-paths.ts`, e.g.:

```ts
export function getSharedPlaywrightSettingsPath(dataDir: string): string {
  return join(getSharedDir(dataDir), 'playwright-dashboard.json')
}
```

That keeps this as shared backend UI/config state, consistent with `shared/`.

## Recommended persisted format

```json
{
  "enabled": true,
  "updatedAt": "2026-03-09T15:00:00.000Z"
}
```

Write atomically using the same temp-file + rename pattern used elsewhere.

## Recommended API surface for settings

Either:

### Option A: keep settings under `/api/settings`
- `GET /api/settings/playwright`
- `PUT /api/settings/playwright`

### Option B: co-locate with feature routes
- `GET /api/playwright/settings`
- `PUT /api/playwright/settings`

My recommendation: **Option A for toggle, Option B for discovery data**.

## Suggested response shape

```json
{
  "settings": {
    "enabled": true,
    "effectiveEnabled": true,
    "source": "settings",
    "envOverride": null,
    "updatedAt": "..."
  }
}
```

Where:
- `enabled`: persisted/user-requested value
- `effectiveEnabled`: actual runtime effect after env override
- `source`: `env` | `settings` | `default`

---

## 8. Protocol type additions needed

## Relevant files
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/index.ts`
- optionally a new `packages/protocol/src/playwright.ts`

## Important current state

`packages/protocol` is authoritative for:
- WebSocket command types
- WebSocket server events
- shared agent/session/message types

But **HTTP response types are not centrally modeled there today**. The frontend often validates route responses locally, e.g. in:
- `apps/ui/src/components/settings/settings-api.ts`

So for Playwright, you can either:
- keep HTTP payloads ad hoc like current routes, or
- improve things by adding shared HTTP DTO types in protocol

## Recommended protocol additions

I recommend adding a dedicated file:
- `packages/protocol/src/playwright.ts`

Suggested shared types:

```ts
export interface PlaywrightSessionCorrelation {
  matchedAgentId?: string
  matchedManagerId?: string
  matchedProfileId?: string
  confidence: 'high' | 'medium' | 'low' | 'none'
  reasons: string[]
}

export interface PlaywrightDiscoveredSession {
  id: string
  sessionFilePath: string
  socketPath?: string
  socketAlive: boolean
  worktreePath?: string
  repoRootPath?: string
  branch?: string
  registryFilePath?: string
  envFilePath?: string
  ports: {
    app?: number
    ws?: number
    inspector?: number
  }
  worker: PlaywrightSessionCorrelation
  updatedAt: string
}

export interface PlaywrightDiscoverySnapshot {
  enabled: boolean
  updatedAt: string
  sessions: PlaywrightDiscoveredSession[]
}

export interface PlaywrightDiscoverySettings {
  enabled: boolean
  effectiveEnabled: boolean
  source: 'env' | 'settings' | 'default'
  updatedAt?: string
}
```

Then export from:
- `packages/protocol/src/index.ts`

## Recommended new WS events

Add to `packages/protocol/src/server-events.ts`:

```ts
export interface PlaywrightDiscoverySnapshotEvent {
  type: 'playwright_discovery_snapshot'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoveryUpdatedEvent {
  type: 'playwright_discovery_updated'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoverySettingsUpdatedEvent {
  type: 'playwright_discovery_settings_updated'
  settings: PlaywrightDiscoverySettings
}
```

And extend `ServerEvent` union.

## Do you need `ClientCommand` additions?

Probably not.

This feature fits better as:
- REST fetches for initial state / mutation (`GET`, `PUT`, `POST /rescan`)
- WS push events for live updates

So `packages/protocol/src/client-commands.ts` can likely remain unchanged.

---

## 9. Concrete backend integration plan

## A. New backend service files

Add:
- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-settings-service.ts`
- optionally `apps/backend/src/playwright/playwright-utils.ts`

## B. Config + paths

Modify:
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/types.ts` if you add config fields
- `apps/backend/src/swarm/data-paths.ts`

Recommended additions:
- env parsing for `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`
- helper for `shared/playwright-dashboard.json`

## C. Server wiring

Modify:
- `apps/backend/src/index.ts`
- `apps/backend/src/ws/server.ts`

## D. HTTP routes

Add:
- `apps/backend/src/ws/routes/playwright-routes.ts`

Modify:
- `apps/backend/src/ws/server.ts`
- optionally `apps/backend/src/ws/routes/settings-routes.ts` if toggle endpoint lives under `/api/settings`

## E. WS event fanout/bootstrap

Modify:
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`

## F. Agent correlation

Read from:
- `swarmManager.listAgents()`
- `swarmManager.getAgent(...)`
- `~/.middleman/swarm/agents.json` indirectly via manager state

No backend contract changes required for baseline heuristic correlation, but if you later want first-class correlation, add new metadata to `AgentDescriptor` or a sidecar mapping store.

---

## 10. Proposed `PlaywrightDiscoveryService` internals

## Recommended responsibilities

The service should own:
- current enabled/effectiveEnabled state
- current discovery snapshot
- filesystem scan orchestration
- optional watcher + poll loop
- agent correlation against `SwarmManager`
- event emission when snapshot/settings change

It should **not** own:
- swarm agent lifecycle
- WebSocket subscription logic
- HTTP request parsing

## Suggested event contract (service-local)

Emit backend events from the service itself, e.g.:
- `playwright_discovery_snapshot`
- `playwright_discovery_updated`
- `playwright_discovery_settings_updated`

`apps/backend/src/ws/server.ts` can forward these as protocol events.

## Suggested scan phases

1. Determine whether feature is effectively enabled.
2. Resolve candidate roots/worktrees to inspect.
3. Discover `.session` files.
4. Read registry/env files for socket/port metadata.
5. Probe Unix socket liveness.
6. Correlate discovered sessions with agents from `swarmManager.listAgents()`.
7. Normalize and sort results.
8. Compare with previous snapshot.
9. Emit update event only if materially changed.

## Candidate scan roots to consider

Based on existing backend state:
- `config.cwdAllowlistRoots`
- active/known agent `cwd` values from registry
- repo root from `config.paths.rootDir`

This is safer and more relevant than an unrestricted whole-home scan.

## Suggested rescan serialization pattern

Use the scheduler/integration style:
- `running`
- `scanning`
- `pendingScan`
- `activeScanPromise`
- `runExclusive(...)` or `requestScan(reason)`

## Suggested snapshot equality strategy

Normalize before comparing:
- realpath-normalize worktree/session/socket paths
- sort sessions by stable key (`sessionFilePath`)
- sort `reasons` arrays
- compare serialized normalized snapshot or a stable hash

Without normalization, watcher/poll noise will spam WS updates.

---

## 11. Endpoint recommendations in detail

## `GET /api/playwright/sessions`

Return current snapshot:

```json
{
  "enabled": true,
  "updatedAt": "2026-03-09T16:00:00.000Z",
  "sessions": [
    {
      "id": "...",
      "sessionFilePath": "/Users/adam/worktrees/foo/.playwright/bar.session",
      "socketPath": "/tmp/foo.sock",
      "socketAlive": true,
      "worktreePath": "/Users/adam/worktrees/foo",
      "repoRootPath": "/Users/adam/worktrees/foo",
      "branch": "feat/x",
      "ports": { "app": 3000, "ws": 47187 },
      "worker": {
        "matchedAgentId": "pw-worker-1",
        "matchedManagerId": "manager--s2",
        "matchedProfileId": "manager",
        "confidence": "high",
        "reasons": ["cwd_exact_match"]
      },
      "updatedAt": "..."
    }
  ]
}
```

## `POST /api/playwright/rescan`

Return updated snapshot after a forced scan:

```json
{
  "ok": true,
  "snapshot": { ... }
}
```

## `GET /api/settings/playwright`

Return:

```json
{
  "settings": {
    "enabled": true,
    "effectiveEnabled": true,
    "source": "settings",
    "updatedAt": "..."
  }
}
```

## `PUT /api/settings/playwright`

Accept:

```json
{ "enabled": false }
```

Return updated settings and maybe snapshot:

```json
{
  "ok": true,
  "settings": { ... }
}
```

If the toggle changes effective state, the route should call into the discovery service so it can start/stop watchers and emit a WS update.

---

## 12. Specific code snippets to follow

## Atomic JSON write pattern

Used repeatedly in the backend:

```ts
const tmp = `${target}.tmp`;
await mkdir(dirname(target), { recursive: true });
await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await rename(tmp, target);
```

Seen in:
- `apps/backend/src/swarm/persistence-service.ts`
- `apps/backend/src/swarm/secrets-env-service.ts`
- `apps/backend/src/scheduler/cron-scheduler-service.ts`
- `apps/backend/src/swarm/session-manifest.ts`

Use the same for Playwright settings persistence.

## Manual route method handling pattern

```ts
if (request.method === "OPTIONS") {
  applyCorsHeaders(request, response, methods);
  response.statusCode = 204;
  response.end();
  return;
}

if (request.method !== "GET") {
  applyCorsHeaders(request, response, methods);
  response.setHeader("Allow", methods);
  sendJson(response, 405, { error: "Method Not Allowed" });
  return;
}
```

Use this style in the new route bundle for consistency.

## Event bootstrap pattern

```ts
private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
  this.send(socket, {
    type: "ready",
    serverTime: new Date().toISOString(),
    subscribedAgentId: targetAgentId
  });
  this.send(socket, {
    type: "agents_snapshot",
    agents: this.swarmManager.listAgents()
  });
  this.send(socket, {
    type: "profiles_snapshot",
    profiles: this.swarmManager.listProfiles()
  });
  ...
}
```

If you want WS bootstrap for Playwright state, this is the exact insertion point.

---

## 13. Constraints and gotchas discovered

## 1. No generic settings store exists
Only env secrets and auth are implemented. A Playwright toggle needs a new store/service.

## 2. `SwarmConfig` is not reactive
Runtime setting changes should update the service directly; do not rely only on config.

## 3. Route registration is manual and positional
You must explicitly import and spread the new route bundle in `apps/backend/src/ws/server.ts`.

## 4. WS forwarding is manual
Adding a new event to `packages/protocol` is not enough. You must also subscribe/forward it in `apps/backend/src/ws/server.ts`.

## 5. WS bootstrap is manual
If you want current discovery state on connect, add it in `WsHandler.sendSubscriptionBootstrap()` or do an HTTP fetch on client load.

## 6. HTTP contracts are not centrally typed today
If you want shared REST DTOs, you need to add them intentionally; current route responses are mostly ad hoc JSON.

## 7. Correlation is heuristic with current data
There is no first-class Playwright session ID/socket path on worker descriptors.

## 8. Profile vs session matters
A worker’s `managerId` points to a session manager, not a profile. Use `profileId` to group and `managerId` to attach to the owning session.

## 9. There is already a safe place for shared persisted config
`~/.middleman/shared/` is the right home for a global Playwright dashboard setting.

## 10. `cwdAllowlistRoots` is a useful discovery boundary
It already includes repo root and `~/worktrees`; that is a strong hint for where discovery should scan by default.

---

## 14. Recommended exact file changes

## New files
- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-settings-service.ts`
- `apps/backend/src/ws/routes/playwright-routes.ts`
- `packages/protocol/src/playwright.ts` (recommended)

## Backend files to modify
- `apps/backend/src/index.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- optionally `apps/backend/src/ws/routes/settings-routes.ts`
- optionally `apps/backend/src/swarm/types.ts` if config fields are added there

## Protocol files to modify
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/shared-types.ts` or new `packages/protocol/src/playwright.ts`

## Frontend consumer files that will need follow-up
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/components/settings/settings-api.ts`
- wherever the dashboard screen fetches `/api/playwright/sessions`

---

## Final recommendation

Implement Playwright discovery as a **top-level backend service** modeled after `IntegrationRegistryService` + `CronSchedulerService`:

- lifecycle in `apps/backend/src/index.ts`
- route bundle in `apps/backend/src/ws/routes/playwright-routes.ts`
- WS forwarding in `apps/backend/src/ws/server.ts`
- bootstrap/filtering in `apps/backend/src/ws/ws-handler.ts`
- shared event/types in `packages/protocol`
- dedicated persisted toggle in `~/.middleman/shared/playwright-dashboard.json`
- env override via `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`

That is the architecture most aligned with how the backend is already built, and it avoids overloading `SwarmManager` or the existing secrets/auth settings system with unrelated concerns.

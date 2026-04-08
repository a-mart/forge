# Forge Extensions

Forge Extensions are a small Forge-native hook system for local automation, policy enforcement, and repository-specific integrations.

They are separate from [Pi Extensions & Packages](PI_EXTENSIONS.md):
- **Forge Extensions** observe Forge concepts like session lifecycle, runtime errors, embedded versioning commits, and tool execution across runtimes.
- **Pi extensions/packages** extend the Pi runtime directly with Pi's event model, custom tools, packages, skills, prompts, and themes.

Use Forge Extensions when you want to react to Forge behavior. Use Pi extensions/packages when you want Pi-native extensibility.

> **Security warning:** Forge extensions run arbitrary local code inside the Forge backend process with your user permissions. They can read files, write files, run commands, and call external services. Only install or write extensions you trust.

## Quick start

A Forge extension is a local `.ts` or `.js` file with a default export function:

```ts
// ~/.forge/extensions/protect-env.ts
export const extension = {
  name: "protect-env",
  description: "Block writes to .env files",
}

export default (forge) => {
  forge.on("tool:before", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return

    const path = typeof event.input.path === "string" ? event.input.path : ""
    if (!path.endsWith(".env")) return

    return {
      block: true,
      reason: "Writes to .env files are blocked by Forge policy.",
    }
  })
}
```

No build step. No restart for discovery changes in Settings. Runtime-bound behavior refreshes the next time the affected session/runtime is created.

## Discovery directories

Forge discovers extensions from these directories:

| Scope | Path |
|---|---|
| Global | `${FORGE_DATA_DIR}/extensions/` |
| Profile | `${FORGE_DATA_DIR}/profiles/<profileId>/extensions/` |
| Project-local | `<cwd>/.forge/extensions/` |

Notes:
- Forge auto-creates the global and profile directories.
- Forge does **not** auto-create project-local directories.
- Project-local resolution uses the session or agent **exact cwd**. Forge does **not** walk ancestor directories.
- Resolution order is **global → profile → project-local**.
- Within each scope, execution order is normalized path sort.
- All matching extensions run. There is **no name-based shadowing**.

Supported entrypoints:
- `my-ext.ts`
- `my-ext.js`
- `my-ext/index.ts`
- `my-ext/index.js`

## Module contract

```ts
export const extension?: {
  name?: string
  description?: string
}

export default (forge: ForgeApi) => void | Promise<void>
```

The named `extension` export is optional display metadata only.

The default export receives a small API:

```ts
forge.on(eventName, handler)
```

That is the whole authoring model. No manifests, no classes, no middleware chain, no `next()`.

## Hook catalog

| Hook | Purpose | Return value |
|---|---|---|
| `session:lifecycle` | Observe manager session create, fork, rename, and delete | none |
| `tool:before` | Observe, block, or rewrite tool input before execution | `{ block, reason }` or `{ input }` |
| `tool:after` | Observe final tool execution result | none |
| `runtime:error` | Observe normalized runtime errors before Forge decides whether fallback recovery should handle them | none |
| `versioning:commit` | Observe successful embedded Git commits in the Forge data dir | none |

Behavior rules:
- `tool:before` can block or replace the entire input object.
- If one `tool:before` handler returns `{ input }`, later handlers see that replaced input.
- If one `tool:before` handler returns `{ block: true }`, remaining `tool:before` handlers do not run.
- `tool:after` is observe-only.
- `tool:after` receives the **final executed input** and a stable result envelope:
  - success: `{ ok: true, value, raw? }`
  - failure: `{ ok: false, error, raw? }`

## Failure model

Forge Extensions are **fail-open**.

That means:
- A discovery or load failure skips that extension.
- A handler error is logged and recorded in Settings diagnostics.
- Other extensions still run.
- The session or runtime keeps going.

Forge does not hot-reload an active session. Runtime-bound hooks refresh on the next runtime or session creation boundary.

## Forge vs Pi behavior

Forge-owned tools are wrapped directly, so Forge hooks work across Pi, Claude SDK, and Codex runtimes.

For Pi-native tools such as `read`, `bash`, `edit`, `write`, package tools, and Pi-extension tools, Forge installs a small internal Pi bridge so the same Forge hooks can observe them in Pi runtimes.

Important v1 limitation:
- **Ordering between the Forge Pi bridge and user Pi extensions is intentionally unspecified in v1.** Do not rely on Forge `tool:before` running before or after user Pi `tool_call` handlers for the same Pi-native tool.

## Diagnostics in Settings

Settings → Extensions shows both systems:
- **Forge Extensions**
- **Pi Extensions & Packages**

The Forge section shows:
- discovered files from disk
- optional metadata (`name`, `description`)
- active runtime bindings
- recent load and handler errors
- discovery directories

Use this view for visibility and troubleshooting. The filesystem is still the configuration surface.

## Examples

### protect-env

```ts
export const extension = {
  name: "protect-env",
  description: "Block writes to .env files",
}

export default (forge) => {
  forge.on("tool:before", (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return

    const path = typeof event.input.path === "string" ? event.input.path : ""
    if (!path.endsWith(".env")) return

    return {
      block: true,
      reason: "Writes to .env files are blocked by Forge policy.",
    }
  })
}
```

### session-audit

```ts
import { appendFileSync } from "node:fs"
import { join } from "node:path"

export default (forge) => {
  const logFile = join(forge.dataDir, "session-audit.jsonl")

  forge.on("session:lifecycle", (event) => {
    appendFileSync(logFile, `${JSON.stringify(event)}\n`)
  })
}
```

### versioning-webhook

```ts
export default (forge) => {
  const webhookUrl = process.env.FORGE_VERSIONING_WEBHOOK_URL
  if (!webhookUrl) return

  forge.on("versioning:commit", async (event, ctx) => {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sha: event.sha,
          subject: event.subject,
          paths: event.paths,
          profileIds: event.profileIds,
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      ctx.log.warn("versioning webhook failed", { error: String(error) })
    }
  })
}
```

### git-attribution

```ts
import { execFileSync } from "node:child_process"

export const extension = {
  name: "git-attribution",
  description: "Add Forge trailers to git commits based on recent file edits",
}

export default (forge) => {
  const lastWriterByPath = new Map()

  forge.on("tool:after", (event, ctx) => {
    if (event.isError) return
    if (event.toolName !== "write" && event.toolName !== "edit") return

    const path = typeof event.input.path === "string" ? event.input.path : ""
    if (!path) return

    lastWriterByPath.set(path, {
      agentId: ctx.agent.agentId,
      role: ctx.agent.role,
      specialistId: ctx.agent.specialistId,
      model: `${ctx.agent.model.provider}/${ctx.agent.model.modelId}`,
    })
  })

  forge.on("tool:before", (event, ctx) => {
    if (event.toolName !== "bash") return

    const command = typeof event.input.command === "string" ? event.input.command : ""
    if (!/\bgit\s+commit\b/.test(command)) return

    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: ctx.session.cwd,
      encoding: "utf8",
    }).trim()

    const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const contributors = stagedFiles
      .map((file) => lastWriterByPath.get(file) ?? [...lastWriterByPath.entries()].find(([path]) => path.endsWith(`/${file}`))?.[1])
      .filter(Boolean)

    const uniqueContributors = Array.from(new Map(contributors.map((c) => [c.agentId, c])).values())

    const trailers = [
      `Forge-Session: ${ctx.session.label ?? ctx.session.sessionAgentId}`,
      `Forge-Committer: ${ctx.agent.agentId}`,
      `Forge-Committer-Model: ${ctx.agent.model.provider}/${ctx.agent.model.modelId}`,
      ...uniqueContributors.map((c) => `Forge-Contributor: ${c.agentId};role=${c.role};model=${c.model}${c.specialistId ? `;specialist=${c.specialistId}` : ""}`),
    ]

    const trailerFlags = trailers.map((value) => `--trailer ${JSON.stringify(value)}`).join(" ")

    return {
      input: {
        ...event.input,
        command: `${command} && git log -1 --format=%B | git interpret-trailers ${trailerFlags} | git commit --amend -F -`,
      },
    }
  })
}
```

## Troubleshooting

### My extension does not appear in Settings
- Check the file path and scope.
- Make sure the file ends in `.ts` or `.js`, or is a directory with `index.ts` / `index.js`.
- Remember project-local discovery uses the exact session cwd only.

### My extension appears, but it is not active
- Runtime-bound hooks activate when a session or runtime is created.
- Start a new session, recycle the affected runtime, or recreate the worker.

### One extension broke, but the session kept running
That is expected. Forge extensions are fail-open.

### My Pi-native tool ordering is inconsistent
That is a v1 limitation. Forge's Pi bridge ordering relative to user Pi extensions is unspecified.

### I need Pi custom tools or packages, not Forge hooks
Use [Pi Extensions & Packages](PI_EXTENSIONS.md).

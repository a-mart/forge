Workers are agents that the manager spawns to handle tasks. They appear in two places: the pill bar above the message area, and nested under sessions in the sidebar. Failed worker turns appear in the transcript as system error messages with the last error context preserved, and the same turn will not produce duplicate end reports.

## Worker pill bar

When workers are actively streaming, green pills appear in a bar above the chat input. Each pill shows the worker's name and a live elapsed timer.

**Hover** a pill to see the worker's model, reasoning level, and latest tool call.

**Click** a pill to open a quick-look popover with recent activity, including tool calls and messages. From there you can click "View full conversation" to navigate to that worker's transcript.

Pills fade out when a worker finishes and disappear after a short delay.

## Workers in the sidebar

Expand a session in the sidebar to see its workers listed underneath. Each worker shows a status dot (green = active, gray = idle) and an optional specialist badge.

Right-click a worker to Stop, Resume, or Delete it.

## Specialist badges

Workers spawned from a specialist template show a colored badge with the specialist name. This helps you identify which worker was assigned which role. Tool rows also include actor labels with worker, specialist, and model metadata.

## Monitoring

The session row itself shows a numbered amber ring when workers are actively streaming, telling you at a glance how many are running. If compaction or context recovery is also active, a violet pulsing `C` badge appears beside the worker-count badge. Hover the session in the sidebar for model and reasoning details.

When an eligible Pi-runtime worker is actively generating enough streamed output, its pill and Quick Look can append an approximate `tok/s` rate. The rate remains absent rather than showing `0` while it is still being measured or when the call lacks a usable estimate. See **Generation Throughput** for the provider-final value and historical Stats behavior.

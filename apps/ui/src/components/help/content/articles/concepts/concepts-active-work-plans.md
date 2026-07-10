Active Work Plans are currently parked and unavailable. Forge does not expose a Settings toggle, managers do not receive the `task` tool or Active Work guidance, and there is no live Active Work card or header control.

## Current behavior

Forge does not create or update live Work Plans, and retained task snapshots do not hydrate plan views. Normal chat, worker delegation, choices, validation, and final synthesis continue without this coordination surface.

## History and receipts

Older sessions may contain durable `work_plan_created` receipts in canonical session history. Forge can still render these receipts as expandable, read-only records from their creation snapshots. They are not editable, resumable, or active plans.

Very old history entries can still be omitted from byte-budgeted bootstrap payloads.

## Compatibility data

Existing per-session `tasks.json` sidecars and shared `work-plans.json` files are preserved as parked compatibility data. They do not enable the feature or restore the manager tool, guidance, live UI, or snapshot hydration.

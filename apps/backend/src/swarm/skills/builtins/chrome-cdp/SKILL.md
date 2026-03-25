---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
env:
  - name: CDP_CONTEXT_ID
    description: Chrome profile context ID to restrict access to (from profile discovery)
    required: false
  - name: CDP_URL_ALLOW
    description: Comma-separated URL patterns to allow (glob-style, e.g. "localhost:*,*.example.com")
    required: false
  - name: CDP_URL_BLOCK
    description: Comma-separated URL patterns to block (glob-style, e.g. "*mail.google*,*bank*")
    required: false
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly to a live local browser session over WebSocket (no Puppeteer dependency).

All commands use `node ./scripts/cdp.mjs` (path relative to this skill directory).

## Prerequisites

- Chrome/Chromium/Brave/Edge/Vivaldi with remote debugging enabled at `chrome://inspect/#remote-debugging`
- Node.js 22+ (uses built-in `WebSocket`)
- Optional: `CDP_PORT_FILE` if `DevToolsActivePort` is in a non-standard location

## Basic usage

1. List tabs:
   ```bash
   node ./scripts/cdp.mjs list
   ```
2. Copy a target prefix from list output (for example `6BE827FA`).
3. Use that target in commands below.

`<target>` is a unique prefix of a tab `targetId`. If ambiguous, use a longer prefix.

## Commands

### List open pages

```bash
node ./scripts/cdp.mjs list
```

### Screenshot (viewport)

```bash
node ./scripts/cdp.mjs shot <target> [file]
```

### Accessibility snapshot

```bash
node ./scripts/cdp.mjs snap <target>
```

### HTML extraction

```bash
node ./scripts/cdp.mjs html <target> [selector]
```

- No selector: full page HTML
- With selector: HTML for matching element

### Evaluate JavaScript

```bash
node ./scripts/cdp.mjs eval <target> <expr>
```

### Navigate

```bash
node ./scripts/cdp.mjs nav <target> <url>
```

### Network timing summary

```bash
node ./scripts/cdp.mjs net <target>
```

### Click element by selector

```bash
node ./scripts/cdp.mjs click <target> <selector>
```

### Click by CSS pixel coordinates

```bash
node ./scripts/cdp.mjs clickxy <target> <x> <y>
```

### Type into focused element

```bash
node ./scripts/cdp.mjs type <target> <text>
```

### Repeated “load more” clicking

```bash
node ./scripts/cdp.mjs loadall <target> <selector> [ms]
```

### Raw CDP method call

```bash
node ./scripts/cdp.mjs evalraw <target> <method> [json]
```

### Open new tab

```bash
node ./scripts/cdp.mjs open [url]
```

### Stop daemon(s)

```bash
node ./scripts/cdp.mjs stop [target]
```

- No target: stop all daemons
- With target: stop daemon for that tab

## Notes

- Chrome may show an "Allow debugging" prompt on first access per tab.
- The script uses per-tab background daemons to keep sessions alive and reduce repeated prompts.
- Daemons auto-exit after inactivity.

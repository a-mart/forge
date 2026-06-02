Forge supports five AI providers. Each has a different set of models with different tradeoffs.

## OpenAI / Codex

OpenAI offers the GPT-5 model family through the Codex runtime. Separately, Builder web can send a plain leading @Codex or [@Codex] text message to a direct Codex app-server sidecar thread. Selector forms like @Codex -<selector> and inline @Codex:<selector> / [@Codex:<selector>] route through the manager, inject guidance, and enable Codex MCP tools for that turn. The direct sidecar path requires the Codex CLI app-server, is text-only, and is not available in Collaboration.
- **GPT-5.5** — The standard full Codex coding model. Strong at implementation tasks, refactors, debugging, planning, architecture, and multi-step reasoning. Supports all reasoning levels from none to max.
- **GPT-5.4** — Prior full OpenAI coding model. Good for complex planning, architecture, and multi-step reasoning when 5.5 is unavailable or intentionally avoided.
- **GPT-5.4 Mini** — A smaller, faster variant of 5.4. Good for lightweight tasks like reading files, quick edits, and exploration. Much cheaper than the full model.
- **GPT-5.4 Nano** — The smallest variant. Very fast and very cheap. Best for simple lookups, grep-style searches, and tasks where speed matters more than depth.

## Anthropic

Anthropic offers the Claude model family through the Pi-proxied path.

- **Claude Opus 4.6** — Anthropic's top-tier model. Particularly strong at frontend work, UI polish, writing, and nuanced code review. Reasoning levels are limited to low, medium, and high (no "none" or "max").
- **Claude Sonnet 4.5** — A mid-range model. Faster than Opus, still capable. Good for documentation, lighter code tasks, and cases where Opus is overkill.
- **Claude Haiku 4.5** — The fast, affordable option. Use it for bulk tasks, formatting, and anything that does not need deep analysis.

## Claude SDK

Claude SDK uses the local Claude Code CLI OAuth session instead of an API key. It is a native path for Claude models and can be used independently from the Pi-proxied Anthropic path.

- **sdk-opus** — Native Claude SDK preset for Opus-class work.
- **sdk-sonnet** — Native Claude SDK preset for Sonnet-class work.

## Cursor SDK

Cursor SDK uses `CURSOR_API_KEY` and exposes Composer 2.5 for specialist workers only. It is native to the Cursor runtime, and background auth/transport failures stay contained in the worker runtime and show up as worker failures, not app crashes. Codex selector mentions are separate from model selection and do not make Codex a manager model; they use the manager-routed app-server catalog/MCP tool path instead.

## xAI / Grok

xAI provides the Grok model family. Grok models are available for specialist workers but not for manager sessions.

- **Grok 4** — xAI's flagship. Strong general-purpose model.
- **Grok 4 Fast** — Optimized for speed at some quality tradeoff.
- **Grok 4.20** — A newer variant with expanded capabilities.

You need provider credentials for each provider configured in Settings > Auth before its models appear in selectors. Claude SDK uses Claude Code CLI OAuth, Cursor SDK uses `CURSOR_API_KEY`, and SDK models can be disabled in Settings > Models if you do not want to see them. Manager-facing availability is also controlled there, so only enabled models show up in manager create/change/override selectors; Codex selector mentions use a separate catalog path and manager tool route, not the manager model selector list.
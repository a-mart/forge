/**
 * Protected Paths Extension
 * =========================
 *
 * Demonstrates: tool_call interception, blocking writes to sensitive paths
 *
 * This extension intercepts `write` and `edit` tool calls and blocks any
 * that target paths matching a configurable list of protected patterns.
 * It's a practical safety net for preventing accidental modifications to
 * sensitive files like `.env`, `.git/`, or SSH keys.
 *
 * How to install:
 *   Copy this file to one of:
 *     ~/.forge/agent/extensions/protected-paths.ts     (all workers)
 *     ~/.forge/agent/manager/extensions/               (all managers)
 *     <project>/.pi/extensions/                        (project-local)
 *     ~/.forge/profiles/<id>/pi/extensions/             (profile-specific)
 *
 *   No build step required — Pi loads TypeScript directly via jiti.
 *   The extension is picked up the next time an agent session starts.
 *
 * Key patterns shown:
 *   - Returning `{ block: true, reason }` from a `tool_call` handler
 *   - Using `ctx.hasUI` to adapt behavior for headless vs interactive mode
 *   - Configurable protection rules via a simple array
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

function normalizeForMatch(value: string): string {
	return path.normalize(value).replace(/\\/g, "/").toLowerCase();
}

export default function (pi: ExtensionAPI) {
	// ── Configuration ──────────────────────────────────────────────────
	// Add or remove path patterns here. Any tool_call whose normalized `path`
	// input contains one of these normalized substrings will be blocked.
	const protectedPaths = [
		".env", // Environment variables / secrets
		".git/", // Git internals (hooks, config, objects)
		"~/.ssh/", // SSH keys and config
		"id_rsa", // SSH private keys by common name
		"id_ed25519", // SSH private keys (ed25519)
	];

	const normalizedPatterns = protectedPaths.map((pattern) => ({
		original: pattern,
		normalized: normalizeForMatch(pattern),
	}));

	// ── Interception ───────────────────────────────────────────────────
	// The `tool_call` event fires before every tool execution. Returning
	// `{ block: true }` prevents the tool from running and sends the
	// `reason` back to the model as the tool result.
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept file-writing tools
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined; // Allow all other tools to proceed
		}

		const rawFilePath = event.input.path;
		if (typeof rawFilePath !== "string" || rawFilePath.trim().length === 0) {
			return undefined;
		}

		const normalizedFilePath = normalizeForMatch(rawFilePath);

		// Check if the target path matches any protected pattern
		const matchedPattern = normalizedPatterns.find(({ normalized }) =>
			normalizedFilePath.includes(normalized),
		);

		if (matchedPattern) {
			const reason = `Blocked: "${rawFilePath}" matches protected pattern "${matchedPattern.original}"`;

			// Log to backend console for debugging/auditing
			console.warn(`[protected-paths] ${reason}`);

			// In interactive Pi (not Forge), show a UI notification.
			// In Forge's headless mode, ctx.hasUI is false and this is skipped.
			if (ctx.hasUI) {
				ctx.ui.notify(reason, "warning");
			}

			// Returning { block: true } prevents the tool from executing.
			// The `reason` string is sent back to the model as the tool result,
			// so the model understands why its action was rejected.
			return { block: true, reason };
		}

		// No match — allow the tool call to proceed normally
		return undefined;
	});
}

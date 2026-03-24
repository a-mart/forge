/**
 * Session Shutdown Cleanup Extension
 * ===================================
 *
 * Demonstrates: session_shutdown lifecycle hook, session-level bookkeeping
 *
 * This extension tracks basic session metrics (start time, tool call count)
 * and writes a summary log entry when the session shuts down. It's a minimal
 * example proving that the `session_shutdown` lifecycle event works reliably
 * for cleanup and finalization tasks.
 *
 * How to install:
 *   Copy this file to one of:
 *     ~/.forge/agent/extensions/session-shutdown-cleanup.ts   (all workers)
 *     ~/.forge/agent/manager/extensions/                      (all managers)
 *     <project>/.pi/extensions/                               (project-local)
 *     ~/.forge/profiles/<id>/pi/extensions/                   (profile-specific)
 *
 * Key patterns shown:
 *   - Using `session_start` and `session_shutdown` as a matched lifecycle pair
 *   - Accumulating in-memory state across events within a single session
 *   - Writing a summary log on shutdown via `session.extensionRunner`
 *   - Safe, non-throwing cleanup (shutdown handlers should never crash)
 *
 * How it works in Forge:
 *   Forge emits `session_shutdown` through the public `session.extensionRunner`
 *   API when a manager or worker session is disposed. This fires during normal
 *   session termination, agent kill, and server shutdown.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Configuration ──────────────────────────────────────────────────────
const LOG_PATH = path.join(
	os.homedir(),
	".forge",
	"agent",
	"session-log.jsonl",
);

export default function (pi: ExtensionAPI) {
	// ── Session state (in-memory, per-session) ───────────────────────
	// Each extension instance lives for one session, so module-level
	// state is effectively session-scoped.
	let sessionStartTime: number | null = null;
	let toolCallCount = 0;
	let toolErrorCount = 0;

	// ── Track session start ──────────────────────────────────────────
	pi.on("session_start", async () => {
		sessionStartTime = Date.now();
		console.log("[session-cleanup] Session started, tracking metrics");
	});

	// ── Count tool calls ─────────────────────────────────────────────
	// Increment counters on every tool result to track session activity.
	pi.on("tool_result", async (event) => {
		toolCallCount++;
		if (event.isError) {
			toolErrorCount++;
		}
		return undefined; // Don't modify the result
	});

	// ── Write summary on shutdown ────────────────────────────────────
	// `session_shutdown` fires when the session is being disposed.
	// This is the place for cleanup, finalization, and summary logging.
	//
	// Important: shutdown handlers should be defensive — wrap everything
	// in try/catch so a logging failure doesn't interfere with session
	// disposal. Forge catches shutdown errors, but it's good practice.
	pi.on("session_shutdown", async () => {
		try {
			const endTime = Date.now();
			const durationMs = sessionStartTime
				? endTime - sessionStartTime
				: 0;
			const durationSec = Math.round(durationMs / 1000);

			const summary = {
				timestamp: new Date(endTime).toISOString(),
				durationSeconds: durationSec,
				toolCalls: toolCallCount,
				toolErrors: toolErrorCount,
			};

			// Ensure the log directory exists
			const dir = path.dirname(LOG_PATH);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			// Append as a single JSON line (JSONL format)
			// Using appendFileSync for simplicity — this is a one-shot
			// write during shutdown, not a hot path.
			fs.appendFileSync(LOG_PATH, JSON.stringify(summary) + "\n", "utf-8");

			console.log(
				`[session-cleanup] Session ended: ${durationSec}s, ` +
					`${toolCallCount} tool calls, ${toolErrorCount} errors. ` +
					`Logged to ${LOG_PATH}`,
			);
		} catch (err) {
			// Never let shutdown logging crash the session disposal
			console.error("[session-cleanup] Failed to write session log:", err);
		}
	});
}

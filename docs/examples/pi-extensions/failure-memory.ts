/**
 * Failure Memory Extension
 * ========================
 *
 * Demonstrates: file-backed extension state, lightweight recall, bounded logs
 *
 * This extension watches for tool errors and records them to a local JSON file.
 * Before each agent turn, it reads recent failures and injects a summary into
 * the agent's context so the model can learn from past mistakes within a session.
 *
 * How to install:
 *   Copy this file to one of:
 *     ~/.forge/agent/extensions/failure-memory.ts       (all workers)
 *     ~/.forge/agent/manager/extensions/                (all managers)
 *     <project>/.pi/extensions/                         (project-local)
 *     ~/.forge/profiles/<id>/pi/extensions/             (profile-specific)
 *
 * Key patterns shown:
 *   - Using `tool_result` to observe outcomes without modifying them
 *   - Using `before_agent_start` to inject context before each turn
 *   - Safe JSON file reading/writing with error handling
 *   - Bounded append-only log (keeps only the last N entries)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Configuration ──────────────────────────────────────────────────────
const LOG_PATH = path.join(os.homedir(), ".forge", "agent", "failure-log.json");
const MAX_FAILURES = 20; // Only retain the most recent N failures

// ── Types ──────────────────────────────────────────────────────────────
interface FailureRecord {
	timestamp: string;
	toolName: string;
	error: string;
	input?: string; // Truncated input for context
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Safely read the failure log, returning an empty array on any error. */
function readFailureLog(): FailureRecord[] {
	try {
		if (!fs.existsSync(LOG_PATH)) return [];
		const raw = fs.readFileSync(LOG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		// Validate it's actually an array
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		// Corrupt or unreadable file — start fresh
		return [];
	}
}

/** Append a failure record and trim to MAX_FAILURES. */
function appendFailure(record: FailureRecord): void {
	const log = readFailureLog();
	log.push(record);

	// Keep only the most recent entries to prevent unbounded growth
	const trimmed = log.slice(-MAX_FAILURES);

	// Ensure the directory exists
	const dir = path.dirname(LOG_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	fs.writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2), "utf-8");
}

/** Truncate a string for logging, keeping it readable. */
function truncate(str: string, maxLen = 120): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen) + "…";
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Record failures ──────────────────────────────────────────────
	// The `tool_result` event fires after every tool execution.
	// We watch for errors and log them without modifying the result.
	pi.on("tool_result", async (event) => {
		if (!event.isError) return undefined; // Only record failures

		// Extract the error text from the tool result content
		const errorText =
			event.content
				?.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text)
				.join("\n") || "Unknown error";

		appendFailure({
			timestamp: new Date().toISOString(),
			toolName: event.toolName,
			error: truncate(errorText, 200),
			input: event.input ? truncate(JSON.stringify(event.input), 120) : undefined,
		});

		console.log(
			`[failure-memory] Recorded failure: ${event.toolName} — ${truncate(errorText, 80)}`,
		);

		// Return undefined to leave the tool result unmodified
		return undefined;
	});

	// ── Inject failure context ───────────────────────────────────────
	// The `before_agent_start` event fires before each agent turn.
	// We read recent failures and inject a summary so the model is
	// aware of past errors and can avoid repeating them.
	pi.on("before_agent_start", async (_event, ctx) => {
		const failures = readFailureLog();
		if (failures.length === 0) return undefined;

		// Take the 5 most recent failures for the context injection
		const recent = failures.slice(-5);
		const summary = recent
			.map(
				(f, i) =>
					`${i + 1}. [${f.timestamp}] ${f.toolName}: ${f.error}`,
			)
			.join("\n");

		const message = [
			"## Recent Tool Failures",
			`The following ${recent.length} recent tool error(s) have been recorded.`,
			"Avoid repeating the same mistakes:",
			"",
			summary,
		].join("\n");

		// Inject as a system-level context addition.
		// This uses ctx.addContext which appends to the system prompt area.
		if (ctx.addContext) {
			ctx.addContext(message);
		}

		return undefined;
	});
}

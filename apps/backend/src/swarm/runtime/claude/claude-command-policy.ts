import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const FOREGROUND_WAIT_MS = 10_000;

/** Bound waiting, not command lifetime. Claude backgrounds ordinary Bash on
 * timeout. Its sleep exception kills instead, so launch those waits explicitly
 * in the background. Forge MCP tools retain their own executor/secret boundary. */
export const claudeCommandWaitHook: HookCallback = async event => {
  if (event.hook_event_name !== "PreToolUse" || !["Bash", "TaskOutput"].includes(event.tool_name)) return {};
  const input = event.tool_input as Record<string, unknown>;
  if (input.run_in_background === true || input.block === false) return {};
  if (typeof input.timeout === "number" && input.timeout > 0 && input.timeout <= FOREGROUND_WAIT_MS) return {};
  // A broad sleep match intentionally also backgrounds compound waits. It avoids
  // depending on Claude's private shell parser to detect its timeout exception.
  const sleep = event.tool_name === "Bash" && typeof input.command === "string" && /\bsleep\b/.test(input.command);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: {
    ...input, ...(sleep ? { run_in_background: true } : { timeout: FOREGROUND_WAIT_MS }),
  } } };
};

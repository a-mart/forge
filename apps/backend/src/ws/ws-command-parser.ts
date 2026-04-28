import type { ClientCommand } from "@forge/protocol";
import { type RawData } from "ws";
import type { CommandParser, ParsedClientCommand } from "./commands/command-parse-helpers.js";
import { parseCollabCommand } from "./commands/parse-collab-command.js";
import { parseConversationCommand } from "./commands/parse-conversation-command.js";
import { parseManagerCommand } from "./commands/parse-manager-command.js";
import { parseProjectAgentCommand } from "./commands/parse-project-agent-command.js";
import { parseSessionCommand } from "./commands/parse-session-command.js";
import { parseUtilityCommand } from "./commands/parse-utility-command.js";

const COMMAND_PARSERS: CommandParser[] = [
  parseUtilityCommand,
  parseManagerCommand,
  parseSessionCommand,
  parseProjectAgentCommand,
  parseCollabCommand,
  parseConversationCommand
];

export type { ParsedClientCommand } from "./commands/command-parse-helpers.js";

export function parseClientCommand(raw: RawData): ParsedClientCommand {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Command must be valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Command must be a JSON object" };
  }

  const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

  for (const parser of COMMAND_PARSERS) {
    const result = parser(maybe);
    if (result) {
      return result;
    }
  }

  return { ok: false, error: "Unknown command type" };
}

export function extractRequestId(command: ClientCommand): string | undefined {
  switch (command.type) {
    case "api_proxy":
    case "create_manager":
    case "delete_manager":
    case "update_manager_model":
    case "update_manager_cwd":
    case "create_session":
    case "stop_session":
    case "resume_session":
    case "delete_session":
    case "clear_session":
    case "rename_session":
    case "pin_session":
    case "set_session_project_agent":
    case "get_project_agent_config":
    case "list_project_agent_references":
    case "get_project_agent_reference":
    case "set_project_agent_reference":
    case "delete_project_agent_reference":
    case "request_project_agent_recommendations":
    case "rename_profile":
    case "fork_session":
    case "merge_session_memory":
    case "get_session_workers":
    case "stop_all_agents":
    case "reorder_profiles":
    case "list_directories":
    case "validate_directory":
    case "pick_directory":
    case "mark_unread":
    case "mark_all_read":
      return command.requestId;

    case "pin_message":
    case "clear_all_pins":
    case "subscribe":
    case "user_message":
    case "collab_bootstrap":
    case "collab_subscribe_channel":
    case "collab_unsubscribe_channel":
    case "collab_user_message":
    case "collab_mark_channel_read":
    case "collab_choice_response":
    case "collab_choice_cancel":
    case "collab_pin_message":
    case "kill_agent":
    case "choice_response":
    case "choice_cancel":
    case "ping":
      return undefined;
  }
}

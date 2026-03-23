export interface IntegrationContextInfo {
  telegram?: {
    connected: boolean;
    botUsername?: string;
    knownChatIds: string[];
  };
}

export function formatIntegrationContext(info: IntegrationContextInfo): string {
  const lines: string[] = [];

  if (info.telegram) {
    lines.push("## Telegram");
    lines.push(`- Status: ${info.telegram.connected ? "connected" : "disconnected"}`);
    if (info.telegram.botUsername) {
      lines.push(`- Bot username: @${info.telegram.botUsername}`);
    }
    if (info.telegram.knownChatIds.length > 0) {
      lines.push(`- Known chat IDs: ${info.telegram.knownChatIds.join(", ")}`);
    } else {
      lines.push("- Known chat IDs: (none yet)");
    }
    lines.push(
      '- You can proactively message Telegram via speak_to_user with target: { channel: "telegram", channelId: "<chat_id>" }'
    );
  }

  if (lines.length === 0) {
    return "";
  }

  return `# Active Integrations\n${lines.join("\n")}`;
}

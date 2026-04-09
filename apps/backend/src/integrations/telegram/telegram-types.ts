export type TelegramConnectionMode = "polling";

export type TelegramParseMode = "HTML";

export interface TelegramIntegrationConfig {
  profileId: string;
  enabled: boolean;
  mode: TelegramConnectionMode;
  botToken: string;
  allowedUserIds: string[];
  polling: {
    timeoutSeconds: number;
    limit: number;
    dropPendingUpdatesOnStart: boolean;
  };
  delivery: {
    parseMode: TelegramParseMode;
    disableLinkPreview: boolean;
    replyToInboundMessageByDefault: boolean;
  };
  attachments: {
    maxFileBytes: number;
    allowImages: boolean;
    allowText: boolean;
    allowBinary: boolean;
  };
}

export interface TelegramIntegrationConfigPublic extends Omit<TelegramIntegrationConfig, "botToken"> {
  botToken: string | null;
  hasBotToken: boolean;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  offset: number;
  length: number;
  type: string;
  url?: string;
  user?: TelegramUser;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramGetMeResult {
  id: number;
  is_bot: true;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramSendMessageResult {
  chatId: string;
  messageId: number;
}

export interface TelegramConnectionTestResult {
  ok: true;
  botId: string;
  botUsername?: string;
  botDisplayName?: string;
}


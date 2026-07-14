import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { persistConversationAttachments } from "../ws/attachment-parser.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment,
} from "./conversation-validators.js";
import type { RuntimeImageAttachment } from "./runtime-contracts.js";
import {
  formatBinaryAttachmentForPrompt,
  formatTextAttachmentForPrompt,
  normalizeConversationAttachments,
  normalizeOptionalAttachmentPath,
  sanitizeAttachmentFileName,
  sanitizePathSegment,
  toConversationAttachmentMetadata,
  toRuntimeDispatchAttachments,
  toRuntimeImageAttachments,
} from "./swarm-manager-utils.js";
import type {
  ConversationAttachment,
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
} from "./types.js";

export interface PreparedConversationAttachments {
  normalizedAttachments: ConversationAttachment[];
  persistedAttachments: ConversationAttachment[];
  attachmentMetadata: ConversationAttachmentMetadata[];
  runtimeAttachments: ConversationAttachment[];
}

export interface PreparedRuntimeAttachments {
  images: RuntimeImageAttachment[];
  attachmentMessage: string;
}

export interface ConversationAttachmentServiceOptions {
  dataDir: string;
  uploadsDir: string;
}

/**
 * Owns the conversion from untrusted conversation attachment payloads to the
 * persisted event metadata and runtime-visible attachment representation.
 */
export class ConversationAttachmentService {
  constructor(private readonly options: ConversationAttachmentServiceOptions) {}

  normalize(attachments: ConversationAttachment[] | undefined): ConversationAttachment[] {
    return normalizeConversationAttachments(attachments);
  }

  /** Persists inbound payloads before the canonical conversation event is emitted. */
  async prepareConversation(
    attachments: ConversationAttachment[] | undefined,
  ): Promise<PreparedConversationAttachments> {
    const normalizedAttachments = this.normalize(attachments);
    const persistedAttachments = normalizedAttachments.length === 0
      ? []
      : await persistConversationAttachments(normalizedAttachments, this.options.uploadsDir);
    const attachmentMetadata = toConversationAttachmentMetadata(
      persistedAttachments,
      this.options.uploadsDir,
    );
    const runtimeAttachments = toRuntimeDispatchAttachments(
      normalizedAttachments,
      persistedAttachments,
    );

    return {
      normalizedAttachments,
      persistedAttachments,
      attachmentMetadata,
      runtimeAttachments,
    };
  }

  /** Builds runtime-visible images and prompt text immediately before dispatch. */
  async prepareRuntime(
    targetAgentId: string,
    attachments: ConversationAttachment[],
  ): Promise<PreparedRuntimeAttachments> {
    if (attachments.length === 0) {
      return { images: [], attachmentMessage: "" };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? await this.createBinaryAttachmentDir(targetAgentId);
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1);
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    const attachmentMessage = this.buildAttachmentMessage(fileMessages, attachmentPathMessages);
    return { images, attachmentMessage };
  }

  private buildAttachmentMessage(fileMessages: string[], attachmentPathMessages: string[]): string {
    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return "";
    }

    const sections: string[] = [];
    if (fileMessages.length > 0) {
      sections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (sections.length > 0) {
        sections.push("");
      }
      sections.push(...attachmentPathMessages);
    }
    return sections.join("\n");
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.options.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: Pick<ConversationBinaryAttachment, "data" | "fileName">,
    attachmentIndex: number,
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(
      attachment.fileName,
      `attachment-${attachmentIndex}.bin`,
    );
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    await writeFile(filePath, Buffer.from(attachment.data, "base64"));
    return filePath;
  }
}

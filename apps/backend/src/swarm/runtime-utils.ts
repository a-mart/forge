import type {
  RuntimeImageAttachment,
  RuntimeUserMessage,
  RuntimeUserMessageInput
} from "./runtime-types.js";

export function normalizeRuntimeUserMessage(input: RuntimeUserMessageInput): RuntimeUserMessage {
  if (typeof input === "string") {
    return {
      text: input,
      images: []
    };
  }

  const text = typeof input.text === "string" ? input.text : "";

  return {
    text,
    images: normalizeRuntimeImageAttachments(input.images)
  };
}

export function normalizeRuntimeImageAttachments(
  images: RuntimeUserMessage["images"]
): RuntimeImageAttachment[] {
  if (!images || images.length === 0) {
    return [];
  }

  const normalized: RuntimeImageAttachment[] = [];

  for (const image of images) {
    if (!image || typeof image !== "object") {
      continue;
    }

    const mimeType = typeof image.mimeType === "string" ? image.mimeType.trim() : "";
    const data = typeof image.data === "string" ? image.data.trim() : "";

    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data
    });
  }

  return normalized;
}

export function buildMessageKey(text: string, images: RuntimeImageAttachment[]): string | undefined {
  const normalizedText = text.trim();
  const normalizedImages = normalizeRuntimeImageAttachments(images);

  if (!normalizedText && normalizedImages.length === 0) {
    return undefined;
  }

  const imageKey = normalizedImages
    .map((image) => `${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`)
    .join(",");

  return `text=${normalizedText}|images=${imageKey}`;
}

export function buildRuntimeMessageKey(message: RuntimeUserMessage): string {
  return buildMessageKey(message.text, message.images ?? []) ?? "text=|images=";
}

export function extractMessageKeyFromRuntimeContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return buildMessageKey(content, []);
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  const images: RuntimeImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const typed = item as {
      type?: unknown;
      text?: unknown;
      mimeType?: unknown;
      data?: unknown;
    };

    if (typed.type === "text" && typeof typed.text === "string") {
      textParts.push(typed.text);
      continue;
    }

    if (
      typed.type === "image" &&
      typeof typed.mimeType === "string" &&
      typeof typed.data === "string"
    ) {
      images.push({
        mimeType: typed.mimeType,
        data: typed.data
      });
    }
  }

  return buildMessageKey(textParts.join("\n"), images);
}

export function consumePendingDeliveryByMessageKey<T extends { messageKey: string }>(
  pendingDeliveries: T[],
  messageKey: string
): void {
  if (pendingDeliveries.length === 0) {
    return;
  }

  const first = pendingDeliveries[0];
  if (first.messageKey === messageKey) {
    pendingDeliveries.shift();
    return;
  }

  const index = pendingDeliveries.findIndex((item) => item.messageKey === messageKey);
  if (index >= 0) {
    pendingDeliveries.splice(index, 1);
  }
}

export function normalizeRuntimeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

export function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

export interface EmergencyContextTrimMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export interface EmergencyContextTrimOptions {
  headCount?: number;
  tailCount?: number;
  stubText?: string;
}

export interface EmergencyContextTrimResult {
  trimmedMessages: EmergencyContextTrimMessage[];
  wasTrimmed: boolean;
  originalCount: number;
  removedMiddleCount: number;
  removedToolLikeCount: number;
  keptHeadCount: number;
  keptTailCount: number;
}

const DEFAULT_HEAD_COUNT = 8;
const DEFAULT_TAIL_COUNT = 10;
const DEFAULT_STUB_TEXT = "[content removed - emergency context trim]";

export function trimConversationForEmergencyRecovery(
  messages: readonly EmergencyContextTrimMessage[],
  options?: EmergencyContextTrimOptions
): EmergencyContextTrimResult {
  const headCount = normalizeCount(options?.headCount, DEFAULT_HEAD_COUNT);
  const tailCount = normalizeCount(options?.tailCount, DEFAULT_TAIL_COUNT);
  const originalCount = messages.length;

  if (originalCount === 0) {
    return {
      trimmedMessages: [],
      wasTrimmed: false,
      originalCount,
      removedMiddleCount: 0,
      removedToolLikeCount: 0,
      keptHeadCount: 0,
      keptTailCount: 0
    };
  }

  const safeHeadCount = Math.min(headCount, originalCount);
  const tailStart = Math.max(safeHeadCount, originalCount - tailCount);

  const head = messages.slice(0, safeHeadCount);
  const middle = messages.slice(safeHeadCount, tailStart);
  const tail = messages.slice(tailStart);

  if (middle.length === 0) {
    return {
      trimmedMessages: [...messages],
      wasTrimmed: false,
      originalCount,
      removedMiddleCount: 0,
      removedToolLikeCount: 0,
      keptHeadCount: head.length,
      keptTailCount: tail.length
    };
  }

  const removedToolLikeCount = middle.reduce(
    (count, message) => (isToolLikeMessage(message) ? count + 1 : count),
    0
  );

  const summaryStub = buildEmergencyTrimStubMessage(
    options?.stubText ?? DEFAULT_STUB_TEXT,
    middle.length,
    removedToolLikeCount
  );

  return {
    trimmedMessages: [...head, summaryStub, ...tail],
    wasTrimmed: true,
    originalCount,
    removedMiddleCount: middle.length,
    removedToolLikeCount,
    keptHeadCount: head.length,
    keptTailCount: tail.length
  };
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function buildEmergencyTrimStubMessage(
  baseText: string,
  removedMiddleCount: number,
  removedToolLikeCount: number
): EmergencyContextTrimMessage {
  const details =
    removedToolLikeCount > 0
      ? ` Removed ${removedMiddleCount} middle message(s), including ${removedToolLikeCount} tool-related message(s).`
      : ` Removed ${removedMiddleCount} middle message(s).`;

  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `${baseText}${details}`
      }
    ],
    timestamp: Date.now()
  };
}

function isToolLikeMessage(message: EmergencyContextTrimMessage): boolean {
  if (message.role === "toolResult" || message.role === "bashExecution") {
    return true;
  }

  if (message.role !== "assistant") {
    return false;
  }

  if (!Array.isArray(message.content)) {
    return false;
  }

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      continue;
    }

    const type = (block as { type?: unknown }).type;
    if (typeof type !== "string") {
      continue;
    }

    if (/tool[_-]?(?:call|use|result)/i.test(type)) {
      return true;
    }
  }

  return false;
}

import { describe, expect, it } from "vitest";
import {
  trimConversationForEmergencyRecovery,
  type EmergencyContextTrimMessage
} from "../emergency-context-trim.js";

function message(role: string, content: unknown, index: number): EmergencyContextTrimMessage {
  return {
    role,
    content,
    timestamp: index
  };
}

describe("trimConversationForEmergencyRecovery", () => {
  it("keeps head/tail and replaces middle with a stub", () => {
    const messages: EmergencyContextTrimMessage[] = [
      message("system", "system prompt", 0),
      message("user", "task", 1),
      message(
        "assistant",
        [
          { type: "text", text: "running tool" },
          { type: "toolCall", name: "read", arguments: { path: "README.md" } }
        ],
        2
      ),
      message("toolResult", [{ type: "text", text: "big file" }], 3),
      message("assistant", [{ type: "text", text: "summary" }], 4),
      message("user", "next", 5),
      message("assistant", [{ type: "text", text: "latest" }], 6),
      message("assistant", [{ type: "text", text: "newest" }], 7)
    ];

    const result = trimConversationForEmergencyRecovery(messages, {
      headCount: 2,
      tailCount: 2
    });

    expect(result.wasTrimmed).toBe(true);
    expect(result.removedMiddleCount).toBe(4);
    expect(result.removedToolLikeCount).toBe(2);
    expect(result.trimmedMessages).toHaveLength(5);
    expect(result.trimmedMessages[0]).toEqual(messages[0]);
    expect(result.trimmedMessages[1]).toEqual(messages[1]);
    expect(result.trimmedMessages[3]).toEqual(messages[6]);
    expect(result.trimmedMessages[4]).toEqual(messages[7]);

    const stub = result.trimmedMessages[2];
    expect(stub.role).toBe("assistant");
    expect(Array.isArray(stub.content)).toBe(true);
  });

  it("still trims when there are no tool messages in the middle", () => {
    const messages: EmergencyContextTrimMessage[] = [
      message("user", "a", 0),
      message("assistant", [{ type: "text", text: "b" }], 1),
      message("user", "c", 2),
      message("assistant", [{ type: "text", text: "d" }], 3),
      message("user", "e", 4),
      message("assistant", [{ type: "text", text: "f" }], 5)
    ];

    const result = trimConversationForEmergencyRecovery(messages, {
      headCount: 1,
      tailCount: 2
    });

    expect(result.wasTrimmed).toBe(true);
    expect(result.removedMiddleCount).toBe(3);
    expect(result.removedToolLikeCount).toBe(0);
    expect(result.trimmedMessages).toHaveLength(4);
  });

  it("does not trim short conversations", () => {
    const messages: EmergencyContextTrimMessage[] = [
      message("user", "hello", 0),
      message("assistant", [{ type: "text", text: "hi" }], 1),
      message("user", "bye", 2)
    ];

    const result = trimConversationForEmergencyRecovery(messages, {
      headCount: 2,
      tailCount: 2
    });

    expect(result.wasTrimmed).toBe(false);
    expect(result.removedMiddleCount).toBe(0);
    expect(result.trimmedMessages).toEqual(messages);
  });

  it("counts all middle tool messages when middle is entirely tool-heavy", () => {
    const messages: EmergencyContextTrimMessage[] = [
      message("system", "start", 0),
      message("assistant", [{ type: "toolUse", id: "a" }], 1),
      message("toolResult", [{ type: "text", text: "result" }], 2),
      message("assistant", [{ type: "tool_result", value: "x" }], 3),
      message("assistant", [{ type: "text", text: "tail" }], 4)
    ];

    const result = trimConversationForEmergencyRecovery(messages, {
      headCount: 1,
      tailCount: 1
    });

    expect(result.wasTrimmed).toBe(true);
    expect(result.removedMiddleCount).toBe(3);
    expect(result.removedToolLikeCount).toBe(3);
  });
});

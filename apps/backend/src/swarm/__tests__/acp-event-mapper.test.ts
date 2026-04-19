import { describe, expect, it } from "vitest";
import { AcpEventMapper } from "../runtime/acp/acp-event-mapper.js";

describe("AcpEventMapper", () => {
  it("preserves assistant chunk whitespace exactly", () => {
    const mapper = new AcpEventMapper();

    const started = mapper.beginPrompt();
    const firstChunk = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" }
    });
    const secondChunk = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\n\n" }
    });
    const thirdChunk = mapper.mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "  world  " }
    });
    const completed = mapper.completePrompt();

    expect(started).toEqual([{ type: "agent_start" }, { type: "turn_start" }]);
    expect(firstChunk).toEqual([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      },
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: "Hello"
        }
      }
    ]);
    expect(secondChunk).toEqual([
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: "Hello\n\n"
        }
      }
    ]);
    expect(thirdChunk).toEqual([
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: "Hello\n\n  world  "
        }
      }
    ]);
    expect(completed).toEqual([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: "Hello\n\n  world  "
        }
      },
      {
        type: "turn_end",
        toolResults: []
      },
      { type: "agent_end" }
    ]);
  });

  it("preserves native diff content when rawOutput is absent", () => {
    const mapper = new AcpEventMapper();

    mapper.beginPrompt();
    const started = mapper.mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Edit file",
      kind: "native",
      rawInput: {
        path: "README.md"
      }
    });
    const completed = mapper.mapSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "README.md",
          oldText: "old",
          newText: "new"
        }
      ]
    });
    const turnEnd = mapper.completePrompt().find((event) => event.type === "turn_end");

    expect(started).toEqual([
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-1",
        args: {
          path: "README.md"
        }
      }
    ]);
    expect(completed).toEqual([
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-1",
        result: {
          status: "completed",
          content: [
            {
              type: "diff",
              path: "README.md",
              oldText: "old",
              newText: "new"
            }
          ]
        },
        isError: false
      }
    ]);
    expect(turnEnd).toEqual({
      type: "turn_end",
      toolResults: [
        {
          status: "completed",
          content: [
            {
              type: "diff",
              path: "README.md",
              oldText: "old",
              newText: "new"
            }
          ]
        }
      ]
    });
  });
});

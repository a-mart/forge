import { describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../claude-event-mapper.js";

describe("ClaudeEventMapper", () => {
  it("maps streamed assistant message start, delta, and end events", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg-1",
            role: "assistant"
          }
        }
      })
    ).toEqual([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      }
    ]);

    expect(
      mapper.mapEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: "Hello from Claude"
          }
        }
      })
    ).toEqual([
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Claude" }]
        }
      }
    ]);

    expect(
      mapper.mapEvent({
        type: "stream_event",
        event: {
          type: "message_stop"
        }
      })
    ).toEqual([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from Claude" }]
        }
      }
    ]);
  });

  it("maps direct assistant fallback events without a stream twin", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "assistant",
        complete: true,
        message: {
          id: "msg-direct",
          role: "assistant",
          content: [{ type: "text", text: "Direct assistant reply" }]
        }
      })
    ).toEqual([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Direct assistant reply" }]
        }
      }
    ]);
  });

  it("deduplicates a direct assistant copy after streamed delivery", () => {
    const mapper = new ClaudeEventMapper();

    mapper.mapEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg-dup",
          role: "assistant"
        }
      }
    });
    mapper.mapEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Dedup me"
        }
      }
    });
    mapper.mapEvent({
      type: "stream_event",
      event: {
        type: "message_stop"
      }
    });

    expect(
      mapper.mapEvent({
        type: "assistant",
        complete: true,
        message: {
          id: "msg-dup",
          role: "assistant",
          content: [{ type: "text", text: "Dedup me" }]
        }
      })
    ).toEqual([]);
  });

  it("suppresses echoed user messages", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "user",
        message: {
          role: "user",
          content: "hello"
        }
      })
    ).toEqual([]);
  });

  it("maps tool use start and result events", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "bash",
          input: {
            command: "pwd"
          }
        }
      })
    ).toEqual([
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tool-1",
        args: {
          command: "pwd"
        }
      }
    ]);

    expect(
      mapper.mapEvent({
        type: "user",
        parent_tool_use_id: "tool-1",
        tool_use_result: {
          stdout: "/repo"
        }
      })
    ).toEqual([
      {
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "tool-1",
        result: {
          stdout: "/repo"
        },
        isError: false
      }
    ]);

    expect(
      mapper.mapEvent({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "bash",
          input: {
            command: "pwd"
          }
        }
      })
    ).toEqual([
      {
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tool-1",
        args: {
          command: "pwd"
        }
      }
    ]);
  });

  it("deduplicates repeated task start events for the same tool call", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "task_started",
        tool_use_id: "task-1",
        tool_name: "read",
        arguments: { path: "README.md" }
      })
    ).toEqual([
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "task-1",
        args: { path: "README.md" }
      }
    ]);

    expect(
      mapper.mapEvent({
        type: "task_started",
        tool_use_id: "task-1",
        tool_name: "read",
        arguments: { path: "README.md" }
      })
    ).toEqual([]);
  });

  it("suppresses thinking-only assistant events", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "assistant",
        complete: true,
        message: {
          id: "thinking-only",
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal chain of thought" }]
        }
      })
    ).toEqual([]);
  });

  it("extracts context usage from usage metadata", () => {
    const mapper = new ClaudeEventMapper();

    expect(
      mapper.mapEvent({
        type: "message_delta",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 30,
          context_window: 500
        }
      })
    ).toEqual([]);

    expect(mapper.getContextUsage()).toEqual({
      tokens: 160,
      contextWindow: 500,
      percent: 32
    });
  });

  it("clears mapper state on reset", () => {
    const mapper = new ClaudeEventMapper();

    mapper.mapEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg-reset",
          role: "assistant"
        }
      }
    });
    mapper.mapEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Before reset"
        }
      }
    });
    mapper.mapEvent({
      type: "message_delta",
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        context_window: 200
      }
    });

    mapper.reset();

    expect(mapper.getContextUsage()).toBeUndefined();
    expect(
      mapper.mapEvent({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg-reset-2",
            role: "assistant"
          }
        }
      })
    ).toEqual([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: ""
        }
      }
    ]);
  });
});

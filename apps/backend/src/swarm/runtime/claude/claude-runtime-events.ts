import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeSessionEvent, RuntimeSessionMessage } from "../../runtime-contracts.js";

/** Claude emits completed blocks, not Codex commentary/final phases. Hold only the
 * last text block open until the next tool/message or result determines its role. */
export class ClaudeRuntimeEvents {
  private text?: string;
  private streamingText = false;
  private readonly tools = new Map<string, string>();
  private readonly background = new Map<string, string>();
  private readonly taskTools = new Map<string, string>();

  hasBackgroundCommands(): boolean { return this.background.size > 0; }

  foregroundCommands(): string[] {
    return [...this.tools].filter(([id, name]) => name === "Bash" && !this.background.has(id)).map(([id]) => id);
  }

  map(frame: SDKMessage): RuntimeSessionEvent[] {
    if ("parent_tool_use_id" in frame && frame.parent_tool_use_id) return [];
    const events: RuntimeSessionEvent[] = [];
    if (frame.type === "system" && frame.subtype === "task_started" && frame.is_backgrounded && frame.tool_use_id && this.tools.has(frame.tool_use_id)) {
      this.background.set(frame.tool_use_id, frame.task_id);
      events.push({ type: "tool_execution_update", toolName: this.tools.get(frame.tool_use_id)!, toolCallId: frame.tool_use_id,
        executionState: "background", partialResult: { status: "running_in_background", taskId: frame.task_id } });
    }
    if (frame.type === "system" && frame.subtype === "task_updated" && frame.patch.is_backgrounded) {
      // A registered foreground task can later be backgrounded by steering.
      const id = this.taskTools.get(frame.task_id);
      if (id && this.tools.has(id)) {
        this.background.set(id, frame.task_id);
        events.push({ type: "tool_execution_update", toolName: this.tools.get(id)!, toolCallId: id,
          executionState: "background", partialResult: { status: "running_in_background", taskId: frame.task_id } });
      }
    }
    if (frame.type === "system" && frame.subtype === "task_started" && frame.tool_use_id && this.tools.has(frame.tool_use_id)) this.taskTools.set(frame.task_id, frame.tool_use_id);
    if (frame.type === "system" && frame.subtype === "task_notification") {
      const id = frame.tool_use_id ?? this.taskTools.get(frame.task_id);
      const toolName = id ? this.tools.get(id) : undefined;
      if (id && toolName) {
        events.push({ type: "tool_execution_end", toolName, toolCallId: id, isError: frame.status !== "completed",
          result: { status: frame.status === "stopped" ? "cancelled" : frame.status, taskId: frame.task_id, content: [{ type: "text", text: frame.summary }] } });
        this.tools.delete(id); this.background.delete(id);
      }
      this.taskTools.delete(frame.task_id);
    }
    if (frame.type === "stream_event") {
      const event = frame.event;
      if (event.type === "content_block_start" && event.content_block.type === "text") {
        events.push(...this.flush(false));
        this.text = event.content_block.text;
        this.streamingText = true;
        events.push(this.textEvent("message_start", false));
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        this.text = (this.text ?? "") + event.delta.text;
        events.push(this.textEvent("message_update", false));
      }
    }
    if (frame.type === "assistant") {
      for (const block of frame.message.content) {
        if (block.type === "text") {
          if (!this.streamingText) {
            events.push(...this.flush(false));
            this.text = block.text;
            events.push(this.textEvent("message_start", false));
          } else { this.text = block.text; this.streamingText = false; }
        } else if (block.type === "tool_use") {
          events.push(...this.flush(false));
          const toolName = block.name.replace(/^mcp__forge__/, "");
          if (!this.tools.has(block.id)) events.push({ type: "tool_execution_start", toolName, toolCallId: block.id, args: block.input });
          this.tools.set(block.id, toolName);
        }
      }
    }
    if (frame.type === "user" && Array.isArray(frame.message.content)) {
      for (const block of frame.message.content) {
        if (block.type !== "tool_result") continue;
        const toolName = this.tools.get(block.tool_use_id);
        if (!toolName) continue;
        if (this.background.has(block.tool_use_id)) continue;
        events.push({ type: "tool_execution_end", toolName, toolCallId: block.tool_use_id,
          result: { content: block.content }, isError: block.is_error === true });
        this.tools.delete(block.tool_use_id);
      }
    }
    if (frame.type === "system" && frame.subtype === "status" && frame.status === "compacting") {
      events.push({ type: "auto_compaction_start", reason: "threshold" });
    }
    if (frame.type === "system" && frame.subtype === "compact_boundary") {
      events.push({ type: "auto_compaction_end", result: frame.compact_metadata, aborted: false, willRetry: false });
    }
    return events;
  }

  finish(success: boolean, fallback?: string, stopping = false): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    if (this.text === undefined && fallback?.trim()) {
      this.text = fallback;
      events.push(this.textEvent("message_start", false));
    }
    events.push(...this.flush(success));
    for (const [toolCallId, toolName] of this.tools) {
      if (!stopping && this.background.has(toolCallId)) continue;
      events.push({ type: "tool_execution_end", toolName, toolCallId,
        result: { status: stopping ? "cancelled" : "interrupted" }, isError: true });
      this.tools.delete(toolCallId);
    }
    if (stopping) { this.background.clear(); this.taskTools.clear(); }
    return events;
  }

  private flush(final: boolean): RuntimeSessionEvent[] {
    if (this.text === undefined) return [];
    const event = this.textEvent("message_end", final);
    this.text = undefined;
    this.streamingText = false;
    return [event];
  }

  private textEvent(type: "message_start" | "message_update" | "message_end", final: boolean): RuntimeSessionEvent {
    return { type, message: { role: "assistant", content: [{ type: "text", text: this.text ?? "" }],
      stopReason: final ? "stop" : "toolUse" } as RuntimeSessionMessage };
  }
}

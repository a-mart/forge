import { describe, expect, it } from "vitest";
import {
  RuntimeConversationEventMapper,
  safeJson
} from "../session/runtime-conversation-event-mapper.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? "worker",
    displayName: overrides.displayName ?? "Worker",
    role: overrides.role ?? "worker",
    managerId: overrides.managerId ?? "manager",
    status: overrides.status ?? "idle",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    cwd: "/tmp/forge-test",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/forge-test/session.jsonl",
    ...overrides
  };
}

function mapRuntimeEvent(options: {
  agentId?: string;
  event: RuntimeSessionEvent;
  descriptor?: AgentDescriptor;
}) {
  return new RuntimeConversationEventMapper().mapRuntimeEvent({
    agentId: options.agentId ?? options.descriptor?.agentId ?? "worker",
    event: options.event,
    timestamp: FIXED_NOW,
    descriptor: options.descriptor
  });
}

describe("RuntimeConversationEventMapper", () => {
  it("maps worker tool start/update/end to manager-context tool activity before worker-local logs", () => {
    const descriptor = makeDescriptor();

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "tool-1",
          args: { path: "README.md" }
        }
      })
    ).toEqual([
      {
        type: "agent_tool_call",
        agentId: "manager",
        actorAgentId: "worker",
        timestamp: FIXED_NOW,
        kind: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-1",
        text: '{"path":"README.md"}'
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-1",
        text: '{"path":"README.md"}'
      }
    ]);

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_update",
          toolName: "read",
          toolCallId: "tool-1",
          partialResult: { bytes: 10 }
        }
      }).map((projection) => projection.type)
    ).toEqual(["agent_tool_call", "conversation_log"]);

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "tool-1",
          result: { ok: true },
          isError: true
        }
      })
    ).toMatchObject([
      { type: "agent_tool_call", kind: "tool_execution_end", isError: true },
      { type: "conversation_log", kind: "tool_execution_end", isError: true }
    ]);
  });

  it("maps manager tool events to manager-context activity only", () => {
    const descriptor = makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" });

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "tool-2",
          args: { command: "pwd" }
        }
      })
    ).toEqual([
      {
        type: "agent_tool_call",
        agentId: "manager",
        actorAgentId: "manager",
        timestamp: FIXED_NOW,
        kind: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tool-2",
        text: '{"command":"pwd"}'
      }
    ]);
  });

  it("preserves ordinary worker and manager tool results with fullText fields", () => {
    const result = { fullText: "complete ordinary tool output", summary: "short summary" };

    const workerProjections = mapRuntimeEvent({
      descriptor: makeDescriptor(),
      event: {
        type: "tool_execution_end",
        toolName: "ordinary_tool",
        toolCallId: "tool-full-text-worker",
        result,
        isError: false
      }
    });

    expect(workerProjections).toHaveLength(2);
    for (const projection of workerProjections) {
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
      expect(JSON.parse(projection.text)).toEqual(result);
    }

    expect(
      mapRuntimeEvent({
        descriptor: makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" }),
        event: {
          type: "tool_execution_end",
          toolName: "manager_tool",
          toolCallId: "tool-full-text-manager",
          result,
          isError: false
        }
      })
    ).toMatchObject([
      { type: "agent_tool_call", text: JSON.stringify(result) },
    ]);
  });

  it("leaves non-Codex tool results untouched even when they contain model-only-looking keys", () => {
    const result = {
      fullRedactedContent: "ordinary tool field that must remain visible",
      redactedModelContent: "ordinary compatibility field",
      summary: "short summary"
    };

    const projections = mapRuntimeEvent({
      descriptor: makeDescriptor(),
      event: {
        type: "tool_execution_end",
        toolName: "ordinary_tool",
        toolCallId: "tool-non-codex-full-content",
        result,
        isError: false
      }
    });

    expect(projections).toHaveLength(2);
    for (const projection of projections) {
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
      expect(JSON.parse(projection.text)).toEqual(result);
    }
  });

  it("keeps message_start role filtering to user, assistant, and system", () => {
    expect(
      mapRuntimeEvent({
        event: { type: "message_start", message: { role: "tool", content: "ignored" } as never }
      })
    ).toEqual([]);

    expect(
      mapRuntimeEvent({
        event: { type: "message_start", message: { role: "user", content: "hello" } }
      })
    ).toEqual([
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_start",
        role: "user",
        text: "hello"
      }
    ]);
  });

  it("maps worker assistant message_end content, error row, and runtime log in order", () => {
    expect(
      mapRuntimeEvent({
        descriptor: makeDescriptor(),
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "partial answer" },
              { type: "image", mimeType: "image/png", data: "abc" }
            ],
            stopReason: "error",
            errorMessage: "provider quota failed"
          } as never
        }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "worker",
        role: "assistant",
        text: "partial answer",
        attachments: [{ mimeType: "image/png", data: "abc" }],
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_message",
        agentId: "worker",
        role: "system",
        text: "⚠️ Worker reply failed: provider quota failed. The manager may need to retry after checking provider auth, quotas, or rate limits.",
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_end",
        role: "assistant",
        text: "partial answer"
      }
    ]);
  });

  it("maps worker system message_end content before the runtime log", () => {
    expect(
      mapRuntimeEvent({
        event: { type: "message_end", message: { role: "system", content: "system note" } }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "worker",
        role: "system",
        text: "system note",
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_end",
        role: "system",
        text: "system note"
      }
    ]);
  });

  it("does not project successful Project Agent manager assistant message_end as visible conversation text", () => {
    const descriptor = makeDescriptor({
      agentId: "project-agent",
      role: "manager",
      managerId: "project-agent",
      projectAgent: {
        handle: "docs",
        whenToUse: "documentation coordination"
      }
    });

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: "This must remain runtime-only unless speak_to_user is used.",
            stopReason: "end_turn"
          } as never
        }
      })
    ).toEqual([]);
  });

  it("maps manager assistant message_end errors to only a system error row", () => {
    const descriptor = makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" });

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: "unfinished manager answer",
            stopReason: "error",
            errorMessage: "maximum context length exceeded"
          } as never
        }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "manager",
        role: "system",
        text: "⚠️ Manager reply failed because the prompt exceeded the model context window (maximum context length exceeded). Try compacting the conversation to free up context space.",
        timestamp: FIXED_NOW,
        source: "system"
      }
    ]);
  });

  it("gives manager many-image dimension errors an image-history recovery hint", () => {
    const descriptor = makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" });
    const errorMessage =
      "messages.12.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels";

    const projections = mapRuntimeEvent({
      descriptor,
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage
        } as never
      }
    });

    expect(projections).toEqual([
      {
        type: "conversation_message",
        agentId: "manager",
        role: "system",
        text: `⚠️ Manager reply failed because images exceeded the provider's many-image dimension limit (${errorMessage}). Try compacting the conversation or start a new session to remove older images from the model request.`,
        timestamp: FIXED_NOW,
        source: "system"
      }
    ]);
    expect(projections[0]?.text).not.toContain("provider auth and rate limits");
  });

  it("strips full Codex Plugin content from worker and manager audit projections while preserving runtime result and preview", () => {
    const descriptor = makeDescriptor({ internalWorkerKind: "codex_plugin" } as Partial<AgentDescriptor>);
    const preview = "synthetic transcript preview";
    const transcriptTail = "SYNTHETIC_TRANSCRIPT_TAIL_SHOULD_NOT_PERSIST";
    const runtimeResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            selector: "fireflies/fetch_transcript",
            serverName: "fireflies",
            toolName: "fetch_transcript",
            preview,
            fullRedactedContent: `redacted transcript body ${transcriptTail}`,
            fullRedactedContentTruncated: false,
            redactedModelContent: `alternate full content ${transcriptTail}`,
            note:
              "fullRedactedContent is model-only; persisted audit rows must stay preview-bounded."
          })
        }
      ],
      details: {
        ok: true,
        selector: "fireflies/fetch_transcript",
        serverName: "fireflies",
        toolName: "fetch_transcript",
        preview,
        auditId: "audit-1"
      }
    };
    const event: RuntimeSessionEvent = {
      type: "tool_execution_end",
      toolName: "codex_fireflies_fetch_transcript",
      toolCallId: "tool-4",
      result: runtimeResult,
      isError: false
    };

    const projections = mapRuntimeEvent({ descriptor, event });

    expect(JSON.stringify(event.result)).toContain(transcriptTail);
    expect(JSON.stringify(event.result)).toContain("fullRedactedContent");
    expect(projections).toHaveLength(2);
    expect(projections).toMatchObject([
      { type: "agent_tool_call", kind: "tool_execution_end" },
      { type: "conversation_log", kind: "tool_execution_end" }
    ]);

    for (const projection of projections) {
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
      expect(projection.text).toContain(preview);
      expect(projection.text).toContain("fireflies/fetch_transcript");
      expect(projection.text).not.toContain(transcriptTail);
      expect(projection.text).not.toContain("fullRedactedContent");
      expect(projection.text).not.toContain("redactedModelContent");

      const persistedResult = JSON.parse(projection.text) as { content: Array<{ text: string }> };
      expect(JSON.parse(persistedResult.content[0]!.text)).toEqual(runtimeResult.details);
    }
  });

  it("sanitizes browser input and result audit projections without mutating immediate provider data", () => {
    const descriptor = makeDescriptor();
    const input = {
      tabId: "tab-1",
      expression: "document.body.innerText",
      awaitPromise: true,
      selector: "#SECRET_SELECTOR",
      locator: "role=button[name=SECRET_NAME]",
      name: "SECRET_ELEMENT_NAME",
      urlIncludes: "/secret-path",
    };
    const start = mapRuntimeEvent({
      descriptor,
      event: {
        type: "tool_execution_start",
        toolName: "browser_evaluate",
        toolCallId: "browser-1",
        args: input,
      },
    });
    expect(input.expression).toBe("document.body.innerText");
    expect(input.selector).toBe("#SECRET_SELECTOR");
    for (const projection of start) {
      expect(projection.text).not.toContain("document.body.innerText");
      expect(projection.text).not.toContain("SECRET");
      expect(projection.text).not.toContain("selector");
      expect(projection.text).not.toContain("locator");
      expect(projection.text).toContain("utf8Bytes");
      expect(JSON.parse(projection.text)).toMatchObject({
        tabId: "tab-1",
        awaitPromise: true,
        expression: { characters: 23, utf8Bytes: 23 },
      });
    }

    const screenshotData = "SCREENSHOT_BASE64_SECRET";
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              tabId: "tab-1",
              url: "https://SNAPSHOT_URL_SECRET.test/page",
              title: "SNAPSHOT_TITLE_SECRET",
              visibleText: "PAGE_TEXT_SECRET",
              accessibility: { name: "A11Y_SECRET" },
              consoleEntries: [{ text: "CONSOLE_SECRET" }],
              networkEntries: [{ url: "https://secret.test/body" }],
              interactiveElements: [{ tag: "button", name: "Increment", selector: "#increment" }],
              actionTimeline: [{ id: "act-1", action: "click", status: "succeeded" }],
              selector: "#nested-selector-secret",
              screenshot: { data: screenshotData, mimeType: "image/png", width: 800, height: 600 },
            },
          }),
        },
        { type: "image", data: screenshotData, mimeType: "image/png" },
      ],
      details: {
        value: "EVALUATE_RESULT_SECRET",
        remoteObject: { description: "REMOTE_SECRET" },
        expression: "document.body.innerText",
        serializedBytes: 22,
        screenshot: { data: screenshotData, mimeType: "image/png", width: 800, height: 600 },
      },
    };
    const end = mapRuntimeEvent({
      descriptor,
      event: {
        type: "tool_execution_end",
        toolName: "browser_evaluate",
        toolCallId: "browser-1",
        result,
        isError: false,
      },
    });
    expect(JSON.stringify(result)).toContain(screenshotData);
    expect(JSON.stringify(result)).toContain("PAGE_TEXT_SECRET");
    for (const projection of end) {
      expect(projection.text).toContain("serializedBytes");
      expect(projection.text).toContain("image/png");
      expect(projection.text).not.toMatch(/SECRET|visibleText|accessibility|consoleEntries|networkEntries|remoteObject|interactiveElements|actionTimeline/);
      expect(projection.text).not.toContain("SNAPSHOT_URL_SECRET");
      expect(projection.text).not.toContain("SNAPSHOT_TITLE_SECRET");
      expect(projection.text).not.toContain(screenshotData);
      expect(projection.text).not.toContain("document.body.innerText");
      expect(projection.type === "agent_tool_call" || projection.type === "conversation_log").toBe(true);
    }
  });

  it("sanitizes nested browser snapshot text, JSON, and image audit payloads", () => {
    const nestedPageText = "NESTED_VISIBLE_TEXT_SECRET";
    const nestedJson = JSON.stringify({
      ok: true,
      result: {
        tabId: "tab-2",
        visibleText: nestedPageText,
        interactiveElements: [{ name: "Nested Button", selector: "#nested" }],
        actionTimeline: [{ id: "a1", action: "snapshot", status: "succeeded" }],
        accessibility: { role: "document", name: "NESTED_A11Y" },
        consoleEntries: [{ text: "NESTED_CONSOLE" }],
        networkEntries: [{ url: "https://nested.secret/api" }],
        screenshot: { data: "NESTED_PNG_SECRET", mimeType: "image/png", width: 100, height: 50 },
      },
    });
    const result = {
      content: [
        { type: "text", text: nestedJson },
        { type: "text", text: "PLAIN_PAGE_TEXT_SECRET" },
        { type: "image", data: "NESTED_PNG_SECRET", mimeType: "image/png" },
      ],
      details: {
        tabId: "tab-2",
        interactiveElements: [{ name: "Details Button", selector: "#details" }],
        actionTimeline: [{ id: "a2", action: "click", status: "failed" }],
        screenshot: { data: "NESTED_PNG_SECRET", mimeType: "image/png", width: 100, height: 50 },
      },
    };

    const projections = mapRuntimeEvent({
      descriptor: makeDescriptor(),
      event: {
        type: "tool_execution_end",
        toolName: "browser_snapshot",
        toolCallId: "browser-snapshot-1",
        result,
        isError: false,
      },
    });

    expect(JSON.stringify(result)).toContain(nestedPageText);
    expect(JSON.stringify(result)).toContain("NESTED_PNG_SECRET");
    for (const projection of projections) {
      const parsed = JSON.parse(projection.text) as {
        content: Array<{ type: string; text?: string | { characters: number; utf8Bytes: number } }>;
        details: Record<string, unknown>;
      };
      expect(parsed.content.some((entry) => entry.type === "image")).toBe(false);
      expect(parsed.details).not.toHaveProperty("interactiveElements");
      expect(parsed.details).not.toHaveProperty("actionTimeline");
      expect(parsed.details).toMatchObject({
        tabId: "tab-2",
        screenshot: { mimeType: "image/png", width: 100, height: 50 },
      });
      expect(parsed.details.screenshot).not.toHaveProperty("data");

      const nestedTextEntry = parsed.content.find((entry) => typeof entry.text === "string");
      expect(nestedTextEntry).toBeTruthy();
      const nestedPayload = JSON.parse(String(nestedTextEntry!.text));
      expect(nestedPayload.result).toMatchObject({ tabId: "tab-2" });
      expect(nestedPayload.result).not.toHaveProperty("visibleText");
      expect(nestedPayload.result).not.toHaveProperty("interactiveElements");
      expect(nestedPayload.result).not.toHaveProperty("actionTimeline");
      expect(nestedPayload.result).not.toHaveProperty("accessibility");
      expect(nestedPayload.result).not.toHaveProperty("consoleEntries");
      expect(nestedPayload.result).not.toHaveProperty("networkEntries");
      expect(nestedPayload.result.screenshot).not.toHaveProperty("data");

      const plainTextEntry = parsed.content.find((entry) => entry.text && typeof entry.text === "object");
      expect(plainTextEntry?.text).toEqual({ characters: 22, utf8Bytes: 22 });
      expect(projection.text).not.toMatch(/SECRET|Nested Button|#nested|NESTED_A11Y|nested\.secret/);
    }
  });

  it("sanitizes typed browser text input to shape metadata", () => {
    const projections = mapRuntimeEvent({
      descriptor: makeDescriptor(),
      event: {
        type: "tool_execution_start",
        toolName: "browser_type",
        toolCallId: "browser-2",
        args: {
          text: "PASSWORD_SECRET",
          clear: true,
          selector: "#password",
          locator: "role=textbox[name=Password]",
          name: "Password",
        },
      },
    });
    for (const projection of projections) {
      expect(projection.text).not.toContain("PASSWORD_SECRET");
      expect(projection.text).not.toContain("#password");
      expect(projection.text).not.toContain("Password");
      expect(JSON.parse(projection.text)).toEqual({
        text: { characters: 15, utf8Bytes: 15 },
        clear: true,
      });
    }
  });

  it("preserves missing descriptor behavior for tool events", () => {
    expect(
      mapRuntimeEvent({
        agentId: "missing-worker",
        event: {
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "tool-3",
          result: { ok: false },
          isError: false
        }
      })
    ).toEqual([
      {
        type: "conversation_log",
        agentId: "missing-worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "tool_execution_end",
        toolName: "read",
        toolCallId: "tool-3",
        text: '{"ok":false}',
        isError: false
      }
    ]);
  });

  it("preserves safeJson circular and oversized behavior", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    expect(safeJson(circular)).toBe("[object Object]");

    const oversized = safeJson({ value: "x".repeat(40 * 1024) });
    expect(Buffer.byteLength(oversized, "utf8")).toBe(32 * 1024);
    expect(oversized.endsWith(" [truncated]")).toBe(true);
  });
});

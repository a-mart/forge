import { describe, expect, it } from "vitest";

import {
  isCodexAppServerExternalThreadDescriptor,
  shouldExcludeConversationMessageFromModelContext,
} from "../external-threads.js";

describe("external thread helpers", () => {
  it("detects Codex sidecar descriptors", () => {
    expect(
      isCodexAppServerExternalThreadDescriptor({
        agentId: "session-1--codex",
        managerId: "session-1",
        displayName: "Codex",
        role: "worker",
        status: "idle",
        createdAt: "2026-05-30T00:00:00.000Z",
        updatedAt: "2026-05-30T00:00:00.000Z",
        cwd: "/tmp",
        model: { provider: "codex-app-server", modelId: "app-server", thinkingLevel: "none" },
        sessionFile: "/tmp/workers/session-1--codex.jsonl",
        externalThread: {
          type: "codex_app_server",
          persisted: true,
          createdByMention: true,
        },
      }),
    ).toBe(true);
  });

  it("flags parent Codex cards for model-context exclusion", () => {
    expect(
      shouldExcludeConversationMessageFromModelContext({
        type: "conversation_message",
        agentId: "session-1",
        role: "system",
        text: "Sent to Codex",
        timestamp: "2026-05-30T00:00:00.000Z",
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: "session-1--codex",
          requestId: "req-1",
          turnCorrelationId: "turn-1",
          status: "sent",
          excludeFromModelContext: true,
        },
      }),
    ).toBe(true);
  });
});

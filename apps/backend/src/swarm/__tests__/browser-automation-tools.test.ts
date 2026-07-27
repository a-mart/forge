import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { BROWSER_AUTOMATION_OPERATIONS } from "@forge/protocol";
import { createBrowserAutomationManagerInvoker } from "../browser-automation/browser-automation-manager-adapter.js";
import { buildBrowserAutomationTools } from "../browser-automation/browser-automation-tools.js";
import { buildBaseRuntimeTools, isBrowserAutomationEligible } from "../runtime/runtime-tool-plan.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

function descriptor(patch: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager-1",
    displayName: "Manager",
    role: "manager",
    managerId: "manager-1",
    status: "idle",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    cwd: "/repo",
    model: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "medium" },
    sessionFile: "/data/session.jsonl",
    profileId: "profile-1",
    sessionSurface: "builder",
    ...patch,
  };
}

function host(invoke = vi.fn(async (_agentId: string, operation: string) => ({ ok: true, operation, result: {} }))): SwarmToolHost {
  return {
    invokeBrowserAutomation: invoke,
    listAgents: () => [],
    getWorkerActivity: () => undefined,
  } as unknown as SwarmToolHost;
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

const validInputs: Record<string, Record<string, unknown>> = {
  browser_status: {},
  browser_open: {},
  browser_navigate: { url: "https://example.com" },
  browser_resize: { mode: "freeform", width: 800, height: 600 },
  browser_snapshot: {},
  browser_click: { locator: "role=button[name=Save]" },
  browser_type: { text: "hello" },
  browser_press: { key: "Enter" },
  browser_scroll: { deltaY: 100 },
  browser_evaluate: { expression: "Promise.resolve(document.title)" },
  browser_wait_for: { text: "Ready" },
  browser_recording_start: {},
  browser_recording_stop: {},
};

function schemaObjectBranches(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) return anyOf.flatMap((branch) => schemaObjectBranches(branch as Record<string, unknown>));
  return schema.type === "object" ? [schema] : [];
}

describe("browser automation tools", () => {
  it("defines all 13 manager-native schemas and applies protocol defaults through one capability", async () => {
    const invoke = vi.fn(async (_agentId: string, operation: string) => ({ ok: true, operation, result: {} }));
    const tools = buildBrowserAutomationTools(host(invoke), descriptor());
    expect(tools.map((tool) => tool.name)).toEqual([
      "browser_status", "browser_open", "browser_navigate", "browser_resize", "browser_snapshot",
      "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_evaluate",
      "browser_wait_for", "browser_recording_start", "browser_recording_stop",
    ]);
    expect(tools).toHaveLength(BROWSER_AUTOMATION_OPERATIONS.length);
    for (const tool of tools.filter((candidate) => candidate.name !== "browser_snapshot")) {
      await tool.execute("call-1", validInputs[tool.name]!, undefined, undefined, undefined as never);
    }
    expect(invoke).toHaveBeenCalledTimes(12);
    expect(invoke).toHaveBeenCalledWith("manager-1", "open", { show: true, reuseExistingTab: true });
    expect(invoke).toHaveBeenCalledWith("manager-1", "navigate", expect.objectContaining({ readiness: "load", timeoutMs: 15_000 }));
    expect(invoke).toHaveBeenCalledWith("manager-1", "evaluate", expect.objectContaining({ awaitPromise: true, returnByValue: true }));
  });

  it("keeps every schema branch strict", async () => {
    const invoke = vi.fn(async (_agentId: string, operation: string) => ({ ok: true, operation, result: {} }));
    const tools = buildBrowserAutomationTools(host(invoke), descriptor());
    for (const tool of tools) {
      const branches = schemaObjectBranches(tool.parameters as unknown as Record<string, unknown>);
      expect(branches.length, tool.name).toBeGreaterThan(0);
      for (const branch of branches) expect(branch.additionalProperties, tool.name).toBe(false);
      expect(Value.Check(tool.parameters, { ...validInputs[tool.name], unexpectedSelector: "external-chrome" }), tool.name).toBe(false);
    }
  });

  it("preserves typed External Chrome attachment, restricted, conflict, and lost failures", async () => {
    const failures = ["target-not-found", "restricted-target", "lease-conflict", "lease-lost"] as const;
    const invoke = vi.fn(async (_agentId: string, operation: string) => ({
      ok: false as const,
      operation,
      error: { code: failures[invoke.mock.calls.length - 1]!, message: "External Chrome failed.", retryable: false },
    }));
    const tools = buildBrowserAutomationTools(host(invoke), descriptor());
    for (const [index, code] of failures.entries()) {
      const operation = (["browser_status", "browser_open", "browser_navigate", "browser_navigate"] as const)[index]!;
      const result = await byName(tools, operation).execute(`failure-${code}`, validInputs[operation]!, undefined, undefined, undefined as never) as { isError?: boolean; details?: unknown };
      expect(result).toMatchObject({ isError: true, details: { error: { code } } });
    }
  });

  it("returns typed invalid-input failures without invoking the host", async () => {
    const invoke = vi.fn();
    const tool = byName(buildBrowserAutomationTools(host(invoke), descriptor()), "browser_click");
    const result = await tool.execute("call-1", { selector: "button", x: 1, y: 2 }, undefined, undefined, undefined as never) as {
      isError?: boolean;
      details?: unknown;
    };
    expect(result).toMatchObject({ isError: true, details: { error: { code: "invalid-input" } } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves snapshot PNG as a native image while removing base64 from text and details", async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      operation: "snapshot" as const,
      result: {
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        loading: false,
        viewportSetting: { mode: "fill" as const },
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        visibleText: "Hello",
        interactiveElements: [],
        accessibility: { role: "document" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        screenshot: { mimeType: "image/png" as const, data: "U0VDUkVU", width: 800, height: 600 },
      },
    }));
    const tool = byName(buildBrowserAutomationTools(host(invoke), descriptor()), "browser_snapshot");
    const result = await tool.execute("call-1", {}, undefined, undefined, undefined as never) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details: unknown;
    };
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "U0VDUkVU", mimeType: "image/png" },
    ]);
    expect(result.content[0]?.text).not.toContain("U0VDUkVU");
    expect(JSON.stringify(result.details)).not.toContain("U0VDUkVU");
  });

  it("enforces the same eligibility at the manager service boundary", async () => {
    let current = descriptor();
    const invoke = vi.fn(async () => ({ ok: true as const, operation: "status" as const, result: {} as never }));
    const managerInvoke = createBrowserAutomationManagerInvoker({
      getDescriptor: () => current,
      getService: () => ({ invoke } as never),
    });
    await managerInvoke("manager-1", "status", {});
    expect(invoke).toHaveBeenCalledWith("manager-1", "profile-1", "status", {});

    current = descriptor({ sessionSurface: "collab" });
    await expect(managerInvoke("manager-1", "status", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "session-not-found" },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("limits eligibility to normal local Builder managers", () => {
    expect(isBrowserAutomationEligible(descriptor())).toBe(true);
    expect(isBrowserAutomationEligible(descriptor({ role: "worker", managerId: "manager-1" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ sessionSurface: "collab" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ sessionPurpose: "capture_check" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ sessionPurpose: "agent_creator" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ archetypeId: "cortex" }))).toBe(false);
    expect(isBrowserAutomationEligible(descriptor({ cli: { transport: "headless", connectedAt: "2026-07-22T00:00:00.000Z" } as never }))).toBe(false);
    expect(buildBaseRuntimeTools(host(), descriptor()).map((tool) => tool.name)).toContain("browser_snapshot");
    expect(buildBaseRuntimeTools(host(), descriptor({ sessionSurface: "collab" })).map((tool) => tool.name)).not.toContain("browser_snapshot");
  });
});

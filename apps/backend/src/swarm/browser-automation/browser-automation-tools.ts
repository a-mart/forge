import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_AUTOMATION_MAX_EVALUATE_BYTES,
  BROWSER_AUTOMATION_MAX_TIMEOUT_MS,
  BROWSER_AUTOMATION_MAX_URL_LENGTH,
  BROWSER_AUTOMATION_OPERATIONS,
  BROWSER_VIEWPORT_MAX_DIMENSION,
  BROWSER_VIEWPORT_MIN_DIMENSION,
  BROWSER_VIEWPORT_PRESETS,
  BrowserAutomationContractError,
  parseBrowserAutomationInput,
  type BrowserAutomationFailure,
  type BrowserAutomationInputByOperation,
  type BrowserAutomationOperation,
  type BrowserSnapshotResult,
} from "@forge/protocol";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

const TOOL_TEXT_MAX_BYTES = 128 * 1_024;
const tabId = Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Target tab id. Defaults to this Forge session's default tab." }));
const timeoutMs = Type.Optional(Type.Integer({ minimum: 1, maximum: BROWSER_AUTOMATION_MAX_TIMEOUT_MS, default: 15_000 }));
const locator = Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH });
const selector = Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH });
const viewportPreset = Type.Union(Object.keys(BROWSER_VIEWPORT_PRESETS).map((id) => Type.Literal(id)));

const schemas: Record<BrowserAutomationOperation, TSchema> = {
  status: Type.Object({ tabId }, { additionalProperties: false }),
  open: Type.Object({
    tabId,
        url: Type.Optional(Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH })),
    show: Type.Optional(Type.Boolean({ default: true })),
    reuseExistingTab: Type.Optional(Type.Boolean({ default: true })),
  }, { additionalProperties: false }),
  navigate: Type.Union([
    Type.Object({
      tabId,
            url: Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH }),
      readiness: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domContentLoaded"), Type.Literal("none")], { default: "load" })),
      timeoutMs,
    }, { additionalProperties: false }),
    Type.Object({
      tabId,
            environmentPort: Type.Integer({ minimum: 1, maximum: 65_535 }),
      environmentProtocol: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https")])),
      path: Type.Optional(Type.String({ maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH })),
      readiness: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domContentLoaded"), Type.Literal("none")], { default: "load" })),
      timeoutMs,
    }, { additionalProperties: false }),
  ]),
  resize: Type.Union([
    Type.Object({ tabId, mode: Type.Literal("fill"), timeoutMs }, { additionalProperties: false }),
    Type.Object({
      tabId,
            mode: Type.Literal("freeform"),
      width: Type.Integer({ minimum: BROWSER_VIEWPORT_MIN_DIMENSION, maximum: BROWSER_VIEWPORT_MAX_DIMENSION }),
      height: Type.Integer({ minimum: BROWSER_VIEWPORT_MIN_DIMENSION, maximum: BROWSER_VIEWPORT_MAX_DIMENSION }),
      timeoutMs,
    }, { additionalProperties: false }),
    Type.Object({
      tabId,
            mode: Type.Literal("preset"),
      presetId: viewportPreset,
      orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
      timeoutMs,
    }, { additionalProperties: false }),
  ]),
  snapshot: Type.Object({ tabId }, { additionalProperties: false }),
  click: Type.Union([
    Type.Object({ tabId, locator, timeoutMs }, { additionalProperties: false }),
    Type.Object({ tabId, selector, timeoutMs }, { additionalProperties: false }),
    Type.Object({ tabId, x: Type.Number(), y: Type.Number(), timeoutMs }, { additionalProperties: false }),
  ]),
  type: Type.Union([
    Type.Object({
      tabId,
            text: Type.String({ maxLength: BROWSER_AUTOMATION_MAX_EVALUATE_BYTES }),
      clear: Type.Optional(Type.Boolean({ default: false })),
      locator,
      timeoutMs,
    }, { additionalProperties: false }),
    Type.Object({
      tabId,
            text: Type.String({ maxLength: BROWSER_AUTOMATION_MAX_EVALUATE_BYTES }),
      clear: Type.Optional(Type.Boolean({ default: false })),
      selector,
      timeoutMs,
    }, { additionalProperties: false }),
    Type.Object({
      tabId,
            text: Type.String({ maxLength: BROWSER_AUTOMATION_MAX_EVALUATE_BYTES }),
      clear: Type.Optional(Type.Boolean({ default: false })),
      timeoutMs,
    }, { additionalProperties: false }),
  ]),
  press: Type.Object({
    tabId,
        key: Type.String({ minLength: 1, maxLength: 128 }),
    modifiers: Type.Optional(Type.Array(Type.Union([
      Type.Literal("Alt"), Type.Literal("Control"), Type.Literal("Meta"), Type.Literal("Shift"),
    ]), { uniqueItems: true })),
  }, { additionalProperties: false }),
  scroll: Type.Object({
    tabId,
        deltaX: Type.Optional(Type.Number()),
    deltaY: Type.Optional(Type.Number()),
    locator: Type.Optional(locator),
    selector: Type.Optional(selector),
  }, { additionalProperties: false }),
  evaluate: Type.Object({
    tabId,
        expression: Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_EVALUATE_BYTES }),
    awaitPromise: Type.Optional(Type.Boolean({ default: true })),
    returnByValue: Type.Optional(Type.Boolean({ default: true })),
  }, { additionalProperties: false }),
  waitFor: Type.Object({
    tabId,
        locator: Type.Optional(locator),
    selector: Type.Optional(selector),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    urlIncludes: Type.Optional(Type.String({ minLength: 1, maxLength: BROWSER_AUTOMATION_MAX_URL_LENGTH })),
    timeoutMs,
  }, { additionalProperties: false }),
  recordingStart: Type.Object({ tabId }, { additionalProperties: false }),
  recordingStop: Type.Object({
    tabId,
        recordingId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  }, { additionalProperties: false }),
};

const labels: Record<BrowserAutomationOperation, string> = {
  status: "Browser Status",
  open: "Open Browser",
  navigate: "Navigate Browser",
  resize: "Resize Browser",
  snapshot: "Snapshot Browser",
  click: "Click Browser",
  type: "Type in Browser",
  press: "Press Browser Key",
  scroll: "Scroll Browser",
  evaluate: "Evaluate in Browser",
  waitFor: "Wait in Browser",
  recordingStart: "Start Browser Recording",
  recordingStop: "Stop Browser Recording",
};

const descriptions: Record<BrowserAutomationOperation, string> = {
  status: "Inspect the Forge browser and the selected tab for this Forge session.",
  open: "Open or reuse a persistent Forge browser tab. A URL is optional; show defaults to true and reuseExistingTab defaults to true.",
  navigate: "Navigate the selected Forge browser tab to a URL or local environment port and optionally wait for readiness.",
  resize: "Resize the selected Forge browser tab using fill, freeform dimensions, or a device preset.",
  snapshot: "Inspect visible page text, semantic elements, accessibility and diagnostics, and receive a native PNG screenshot.",
  click: "Click exactly one semantic locator, CSS selector, or viewport coordinate pair in the Forge browser page.",
  type: "Type text into a semantic locator, CSS selector, or the focused editable target, optionally clearing it first.",
  press: "Send a key with optional Alt, Control, Meta, and Shift modifiers to the Forge browser page.",
  scroll: "Scroll the viewport or a semantic locator/CSS container by horizontal or vertical deltas.",
  evaluate: "Execute arbitrary JavaScript in the Forge browser page, optionally awaiting promises and returning a by-value result.",
  waitFor: "Wait until all supplied locator, CSS, text, and URL conditions match in the Forge browser page.",
  recordingStart: "Start the single active desktop browser recording. The target tab must be visible.",
  recordingStop: "Stop an explicit or active browser recording and return its canonical local artifact metadata.",
};

export function buildBrowserAutomationTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  return BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({
    name: `browser_${toolSuffix(operation)}`,
    label: labels[operation],
    description: descriptions[operation],
    parameters: schemas[operation],
    async execute(_toolCallId, params) {
      let input: BrowserAutomationInputByOperation[typeof operation];
      try {
        input = parseBrowserAutomationInput(operation, params);
      } catch (error) {
        const message = error instanceof BrowserAutomationContractError ? error.message : String(error);
        return formatFailure(operation, { code: "invalid-input", message, retryable: false });
      }
      if (!host.invokeBrowserAutomation) {
        return formatFailure(operation, {
          code: "unavailable-host",
          message: "Forge browser automation is not available in this runtime.",
          retryable: true,
        });
      }
      const result = await host.invokeBrowserAutomation(descriptor.agentId, operation, input);
      if (!result.ok) return formatFailure(operation, result.error);
      return formatSuccess(operation, result.result);
    },
  }));
}

function formatSuccess(operation: BrowserAutomationOperation, result: unknown) {
  const safeResult = operation === "snapshot" ? snapshotWithoutBytes(result as BrowserSnapshotResult) : result;
  const payload = { ok: true, operation, result: safeResult };
  const boundedText = boundedJson(payload);
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: boundedText },
  ];
  if (operation === "snapshot") {
    const screenshot = (result as BrowserSnapshotResult).screenshot;
    content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
  }
  return { content, details: JSON.parse(boundedText) as unknown };
}

function formatFailure(operation: BrowserAutomationOperation, error: BrowserAutomationFailure) {
  const payload = { ok: false, operation, error };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true,
  };
}

function snapshotWithoutBytes(result: BrowserSnapshotResult): Omit<BrowserSnapshotResult, "screenshot"> & {
  screenshot: Omit<BrowserSnapshotResult["screenshot"], "data"> & { encodedBytes: number };
} {
  const { screenshot, ...metadata } = result;
  return {
    ...metadata,
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      encodedBytes: Buffer.byteLength(screenshot.data, "base64"),
    },
  };
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= TOOL_TEXT_MAX_BYTES) return serialized;
  const record = value as { ok?: unknown; operation?: unknown; result?: Record<string, unknown> };
  const result = record.result ?? {};
  const summary = {
    ok: record.ok,
    operation: record.operation,
    result: {
      ...result,
      visibleText: typeof result.visibleText === "string" ? `${result.visibleText.slice(0, 20_000)} [truncated]` : undefined,
      accessibility: "[omitted: result exceeded tool text bound]",
      consoleEntries: Array.isArray(result.consoleEntries) ? { count: result.consoleEntries.length } : undefined,
      networkEntries: Array.isArray(result.networkEntries) ? { count: result.networkEntries.length } : undefined,
      interactiveElements: Array.isArray(result.interactiveElements) ? result.interactiveElements.slice(0, 50) : result.interactiveElements,
      actionTimeline: Array.isArray(result.actionTimeline) ? result.actionTimeline.slice(-50) : result.actionTimeline,
      truncated: true,
    },
  };
  const fallback = JSON.stringify(summary);
  if (Buffer.byteLength(fallback, "utf8") <= TOOL_TEXT_MAX_BYTES) return fallback;
  return JSON.stringify({ ok: record.ok, operation: record.operation, result: { truncated: true } });
}

function toolSuffix(operation: BrowserAutomationOperation): string {
  switch (operation) {
    case "waitFor": return "wait_for";
    case "recordingStart": return "recording_start";
    case "recordingStop": return "recording_stop";
    default: return operation;
  }
}

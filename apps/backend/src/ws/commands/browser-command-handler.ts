import { resolveBrowserHostKind } from "@forge/protocol";
import type {
  BrowserClientCommand,
  BrowserServerEvent,
  BrowserHostKind,
  BrowserSessionSnapshot,
  BrowserViewportSetting,
  ServerEvent,
} from "@forge/protocol";
import type { BrowserAutomationService } from "../../swarm/browser-automation/index.js";
import type { WebSocket } from "ws";

export interface BrowserCommandHandlerOptions {
  command: BrowserClientCommand;
  socket: WebSocket;
  connectionId: string;
  subscribedAgentId?: string;
  browserAutomationService: BrowserAutomationService;
  resolveManagerContextAgentId: (agentId: string) => string | undefined;
  resolveProfileIdForAgent: (agentId: string) => string | undefined;
  send: (socket: WebSocket, event: ServerEvent) => void;
  sendCritical?: (socket: WebSocket, event: ServerEvent) => Promise<number | null>;
  broadcastToSession: (sessionAgentId: string, event: ServerEvent) => void;
  hydrateHostSessions: (hostKind?: BrowserHostKind) => Promise<BrowserSessionSnapshot[]>;
  logDebug?: (message: string, details?: unknown) => void;
}

export async function handleBrowserCommand(options: BrowserCommandHandlerOptions): Promise<boolean> {
  const { command, browserAutomationService: service, socket, connectionId } = options;
  switch (command.type) {
    case "browser_host_register": {
      let host;
      try {
        host = await service.registerHostWithLifecycleRelease({
          connectionId,
          registration: command.registration,
          sendRequest: async (request) => {
            const sent = await sendCritical(options, { type: "browser_automation_request", request });
            if (sent === null) throw new Error("Browser automation request could not be delivered");
          },
          ...(command.registration.capabilities.hostKind === "external-chrome"
            ? { hydrateSessionsForReplacement: () => options.hydrateHostSessions("external-chrome") }
            : {}),
        });
      } catch {
        sendFailure(
          options,
          command,
          "LIFECYCLE_RELEASE_FAILED",
          "External Chrome host replacement was blocked because its current lease could not be released.",
        );
        return true;
      }
      await sendCritical(options, { type: "browser_host_connected", requestId: command.requestId, host });
      return true;
    }
    case "browser_host_hydrate": {
      if (!service.broker.isCurrentConnection(connectionId, command.hostId, command.hostGeneration, command.hostKind)) {
        sendFailure(options, command, "STALE_HOST_GENERATION", "Browser hydration requested for a stale host generation.");
        return true;
      }
      const sessions = await options.hydrateHostSessions(command.hostKind);
      if (!service.broker.isCurrentConnection(connectionId, command.hostId, command.hostGeneration, command.hostKind)) return true;
      const payload = Buffer.from(JSON.stringify(sessions), "utf8");
      const chunkCount = Math.max(1, Math.ceil(payload.byteLength / MAX_BROWSER_HYDRATION_CHUNK_BYTES));
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        if (!service.broker.isCurrentConnection(connectionId, command.hostId, command.hostGeneration, command.hostKind)) return true;
        const start = chunkIndex * MAX_BROWSER_HYDRATION_CHUNK_BYTES;
        const sent = await sendCritical(options, {
          type: "browser_host_hydration_chunk",
          requestId: command.requestId,
          hostKind: command.hostKind,
          hostId: command.hostId,
          hostGeneration: command.hostGeneration,
          chunkIndex,
          chunkCount,
          payloadBase64: payload.subarray(start, start + MAX_BROWSER_HYDRATION_CHUNK_BYTES).toString("base64"),
        });
        if (sent === null) return true;
      }
      return true;
    }
    case "browser_host_focus":
      service.setHostFocused(connectionId, command.hostId, command.hostGeneration, command.focused, command.hostKind);
      return true;
    case "browser_host_response": {
      const disposition = service.acceptHostResponse(connectionId, command.response);
      if (disposition !== "accepted") options.logDebug?.("browser-response-ignored", { disposition, requestId: command.response.requestId });
      return true;
    }
    case "browser_host_state_report": {
      const result = await service.reportHostState(connectionId, command.hostId, command.hostGeneration, command.sessions, command.hostKind);
      options.send(socket, {
        type: "browser_host_state_report_result",
        requestId: command.requestId,
        result,
      } satisfies BrowserServerEvent);
      if (result.status === "stale-host-generation") {
        options.logDebug?.("browser-state-report-ignored", { hostId: command.hostId, hostGeneration: command.hostGeneration });
      }
      return true;
    }
    case "browser_panel_reveal_acknowledge":
      await handlePanelRevealAcknowledgement(options, command);
      return true;
    case "browser_host_select":
    case "browser_external_chrome_detach_confirmed":
      await handleSessionBrowserCommand(options, command);
      return true;
    case "browser_recording_start":
    case "browser_recording_stop":
      await handleRecordingCommand(options, command);
      return true;
    case "browser_tab_open":
    case "browser_tab_activate":
    case "browser_tab_close":
    case "browser_tab_resize":
      await handleTabCommand(options, command);
      return true;
  }
}

async function handleSessionBrowserCommand(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { type: "browser_host_select" | "browser_external_chrome_detach_confirmed" }>,
): Promise<void> {
  const managerSessionId = options.subscribedAgentId
    ? options.resolveManagerContextAgentId(options.subscribedAgentId)
    : undefined;
  if (managerSessionId !== command.sessionAgentId) {
    sendFailure(options, command, "SUBSCRIPTION_MISMATCH", "Browser host selection must target the selected Forge session.");
    return;
  }
  if (options.resolveProfileIdForAgent(command.sessionAgentId) !== command.profileId) {
    sendFailure(options, command, "PROFILE_MISMATCH", "Browser host selection profile does not match the selected Forge session.");
    return;
  }
  try {
    let snapshot: BrowserSessionSnapshot;
    if (command.type === "browser_host_select") {
      snapshot = await options.browserAutomationService.selectHost(command.profileId, command.sessionAgentId, command.hostKind);
    } else {
      // Backend owns the transaction: exact host-generation IPC release is acknowledged
      // before the canonical External Chrome snapshot is removed.
      await options.browserAutomationService.releaseSessionForLifecycle(command.profileId, command.sessionAgentId, "detach");
      snapshot = await options.browserAutomationService.selectHost(command.profileId, command.sessionAgentId, "managed-electron");
    }
    options.send(options.socket, {
      type: "browser_session_command_succeeded",
      requestId: command.requestId,
      commandType: command.type,
      snapshot: cloneSnapshot(snapshot),
    } satisfies BrowserServerEvent);
  } catch (error) {
    sendFailure(options, command, "FAILED", error instanceof Error ? error.message : String(error));
  }
}

async function handlePanelRevealAcknowledgement(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { type: "browser_panel_reveal_acknowledge" }>,
): Promise<void> {
  const { browserAutomationService: service, connectionId } = options;
  const managerSessionId = options.subscribedAgentId
    ? options.resolveManagerContextAgentId(options.subscribedAgentId)
    : undefined;
  if (managerSessionId !== command.sessionAgentId) {
    sendFailure(options, command, "SUBSCRIPTION_MISMATCH", "Browser reveal acknowledgement must target the selected Forge session.");
    return;
  }
  if (options.resolveProfileIdForAgent(command.sessionAgentId) !== command.profileId) {
    sendFailure(options, command, "PROFILE_MISMATCH", "Browser reveal acknowledgement profile does not match the selected Forge session.");
    return;
  }
  if (!service.broker.isCurrentConnection(connectionId, command.hostId, command.hostGeneration, command.hostKind)) {
    sendFailure(options, command, "STALE_HOST_GENERATION", "Browser reveal acknowledgement came from a stale host generation.");
    return;
  }
  try {
    const snapshot = await service.acknowledgePanelReveal(
      command.profileId,
      command.sessionAgentId,
      command.tabId,
      command.sequence,
    );
    options.send(options.socket, {
      type: "browser_panel_reveal_acknowledged",
      requestId: command.requestId,
      snapshot,
    } satisfies BrowserServerEvent);
  } catch (error) {
    sendFailure(options, command, "INTENT_MISMATCH", error instanceof Error ? error.message : String(error));
  }
}

async function handleRecordingCommand(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { type: "browser_recording_start" | "browser_recording_stop" }>,
): Promise<void> {
  const { browserAutomationService: service, connectionId } = options;
  const subscribedAgentId = options.subscribedAgentId;
  const managerSessionId = subscribedAgentId ? options.resolveManagerContextAgentId(subscribedAgentId) : undefined;
  if (!subscribedAgentId || managerSessionId !== command.sessionAgentId) {
    sendFailure(options, command, "SUBSCRIPTION_MISMATCH", "Browser commands may only target the currently selected Forge session.");
    return;
  }
  const profileId = options.resolveProfileIdForAgent(command.sessionAgentId);
  if (!profileId) {
    sendFailure(options, command, "PROFILE_MISMATCH", "Browser command profile does not match the selected Forge session.");
    return;
  }
  const host = service.broker.getConnectionSnapshot();
  if (!host.connected || !host.hostId || host.hostGeneration === null || !service.broker.isCurrentConnection(connectionId, host.hostId, host.hostGeneration)) {
    sendFailure(options, command, "BROWSER_UNAVAILABLE", "Browser controls require the local Electron host on this connection.");
    return;
  }

  try {
    if (command.type === "browser_recording_start") {
      const outcome = await service.invoke(command.sessionAgentId, profileId, "recordingStart", { tabId: command.tabId, hostKind: "managed-electron" });
      if (!outcome.ok) throw new BrowserCommandFailure(outcome.error.code, outcome.error.message);
      const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      options.send(options.socket, {
        type: "browser_recording_command_succeeded",
        requestId: command.requestId,
        commandType: command.type,
        result: outcome.result,
        snapshot: cloneSnapshot(snapshot),
      } satisfies BrowserServerEvent);
      return;
    }

    const outcome = await service.invoke(command.sessionAgentId, profileId, "recordingStop", {
      tabId: command.tabId,
      hostKind: "managed-electron",
      recordingId: command.recordingId,
    });
    if (!outcome.ok) throw new BrowserCommandFailure(outcome.error.code, outcome.error.message);
    const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
    options.send(options.socket, {
      type: "browser_recording_command_succeeded",
      requestId: command.requestId,
      commandType: command.type,
      result: outcome.result,
      snapshot: cloneSnapshot(snapshot),
    } satisfies BrowserServerEvent);
  } catch (error) {
    const code = error instanceof BrowserCommandFailure ? error.code : "FAILED";
    sendFailure(options, command, code, error instanceof Error ? error.message : String(error));
  }
}

async function handleTabCommand(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { type: "browser_tab_open" | "browser_tab_activate" | "browser_tab_close" | "browser_tab_resize" }>,
): Promise<void> {
  const { browserAutomationService: service, connectionId } = options;
  const subscribedAgentId = options.subscribedAgentId;
  const managerSessionId = subscribedAgentId ? options.resolveManagerContextAgentId(subscribedAgentId) : undefined;
  if (!subscribedAgentId || managerSessionId !== command.sessionAgentId) {
    sendFailure(options, command, "SUBSCRIPTION_MISMATCH", "Browser commands may only target the currently selected Forge session.");
    return;
  }
  const profileId = options.resolveProfileIdForAgent(command.sessionAgentId);
  if (!profileId || (command.type === "browser_tab_open" && command.profileId !== profileId)) {
    sendFailure(options, command, "PROFILE_MISMATCH", "Browser command profile does not match the selected Forge session.");
    return;
  }
  const host = service.broker.getConnectionSnapshot();
  if (!host.connected || !host.hostId || host.hostGeneration === null || !service.broker.isCurrentConnection(connectionId, host.hostId, host.hostGeneration)) {
    sendFailure(options, command, "BROWSER_UNAVAILABLE", "Browser controls require the local Electron host on this connection.");
    return;
  }

  try {
    if (command.type === "browser_tab_open") {
      const before = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      const previousActive = before.activeTabId;
      const previousDefault = before.defaultTabId;
      const previousHostKind = resolveBrowserHostKind(before.hostKind);
      const result = await service.invoke(command.sessionAgentId, profileId, "open", {
        hostKind: "managed-electron",
        ...(command.url ? { url: command.url } : {}),
        show: false,
        reuseExistingTab: false,
      });
      if (!result.ok) throw new BrowserCommandFailure(result.error.code, result.error.message);
      if (command.activate === false) {
        await service.setTabSelection(profileId, command.sessionAgentId, previousActive, previousDefault, previousHostKind);
      }
      const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      sendSuccess(options, command, snapshot);
      return;
    }

    if (command.type === "browser_tab_activate") {
      const next = await service.activateTab(profileId, command.sessionAgentId, command.tabId, "managed-electron");
      sendSuccess(options, command, next);
      return;
    }

    if (command.type === "browser_tab_close") {
      const next = await service.closeTab(profileId, command.sessionAgentId, command.tabId, "managed-electron");
      sendSuccess(options, command, next);
      return;
    }

    const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === command.tabId
      && resolveBrowserHostKind(candidate.hostKind) === "managed-electron"
      && candidate.lifecycle !== "closed");
    if (!tab) throw new BrowserCommandFailure("TAB_NOT_FOUND", "Browser tab was not found in the selected Forge session.");

    if (command.type === "browser_tab_resize") {
      const input = { ...viewportInput(command.viewport, command.tabId), hostKind: "managed-electron" as const };
      const result = await service.invoke(command.sessionAgentId, profileId, "resize", input);
      if (!result.ok) throw new BrowserCommandFailure(result.error.code, result.error.message);
      const next = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      sendSuccess(options, command, next);
    }
  } catch (error) {
    const code = error instanceof BrowserCommandFailure ? error.code : "FAILED";
    sendFailure(options, command, code, error instanceof Error ? error.message : String(error));
  }
}

function sendSuccess(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { type: "browser_tab_open" | "browser_tab_activate" | "browser_tab_close" | "browser_tab_resize" }>,
  snapshot: BrowserSessionSnapshot,
): void {
  options.send(options.socket, {
    type: "browser_tab_command_succeeded",
    requestId: command.requestId,
    commandType: command.type,
    snapshot: cloneSnapshot(snapshot),
  } satisfies BrowserServerEvent);
}

function sendFailure(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { requestId: string }>,
  suffix: string,
  message: string,
): void {
  options.send(options.socket, {
    type: "error",
    code: `${command.type.toUpperCase()}_${suffix.toUpperCase().replaceAll("-", "_")}`,
    message,
    requestId: command.requestId,
  });
}

function viewportInput(viewport: BrowserViewportSetting, tabId: string) {
  if (viewport.mode === "fill") return { tabId, mode: "fill" as const, timeoutMs: 15_000 };
  if (viewport.mode === "freeform") return { tabId, mode: "freeform" as const, width: viewport.width, height: viewport.height, timeoutMs: 15_000 };
  return { tabId, mode: "preset" as const, presetId: viewport.presetId, orientation: viewport.orientation, timeoutMs: 15_000 };
}

function cloneSnapshot(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as BrowserSessionSnapshot;
}

const MAX_BROWSER_HYDRATION_CHUNK_BYTES = 256 * 1024;

async function sendCritical(options: BrowserCommandHandlerOptions, event: ServerEvent): Promise<number | null> {
  if (options.sendCritical) return options.sendCritical(options.socket, event);
  options.send(options.socket, event);
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

class BrowserCommandFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

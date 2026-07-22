import type {
  BrowserClientCommand,
  BrowserServerEvent,
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
  broadcastToSession: (sessionAgentId: string, event: ServerEvent) => void;
  hydrateHostSessions: () => Promise<BrowserSessionSnapshot[]>;
  logDebug?: (message: string, details?: unknown) => void;
}

export async function handleBrowserCommand(options: BrowserCommandHandlerOptions): Promise<boolean> {
  const { command, browserAutomationService: service, socket, connectionId } = options;
  switch (command.type) {
    case "browser_host_register": {
      const host = service.registerHost({
        connectionId,
        registration: command.registration,
        sendRequest: (request) => options.send(socket, { type: "browser_automation_request", request }),
      });
      options.send(socket, { type: "browser_host_connected", host });
      const sessions = await options.hydrateHostSessions();
      if (service.broker.isCurrentConnection(connectionId, command.registration.hostId, host.hostGeneration ?? -1)) {
        options.send(socket, {
          type: "browser_host_state_snapshot",
          hostId: command.registration.hostId,
          hostGeneration: host.hostGeneration!,
          sessions,
        });
      }
      return true;
    }
    case "browser_host_focus":
      service.setHostFocused(connectionId, command.hostId, command.hostGeneration, command.focused);
      return true;
    case "browser_host_response": {
      const disposition = service.acceptHostResponse(connectionId, command.response);
      if (disposition !== "accepted") options.logDebug?.("browser-response-ignored", { disposition, requestId: command.response.requestId });
      return true;
    }
    case "browser_host_state_report": {
      const accepted = await service.reportHostState(connectionId, command.hostId, command.hostGeneration, command.sessions);
      if (!accepted) options.logDebug?.("browser-state-report-ignored", { hostId: command.hostId, hostGeneration: command.hostGeneration });
      return true;
    }
    case "browser_tab_open":
    case "browser_tab_activate":
    case "browser_tab_close":
    case "browser_tab_resize":
      await handleTabCommand(options, command);
      return true;
  }
}

async function handleTabCommand(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { requestId: string }>,
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
      const result = await service.invoke(command.sessionAgentId, profileId, "open", {
        ...(command.url ? { url: command.url } : {}),
        show: false,
        reuseExistingTab: false,
      });
      if (!result.ok) throw new BrowserCommandFailure(result.error.code, result.error.message);
      const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      if (command.activate === false) {
        // The host reports the true active tab on its next state update. The
        // create response still contains the complete canonical tab inventory.
      }
      sendSuccess(options, command, snapshot);
      return;
    }

    const snapshot = await service.getSessionSnapshot(profileId, command.sessionAgentId);
    const tab = snapshot.tabs.find((candidate) => candidate.tabId === command.tabId && candidate.lifecycle !== "closed");
    if (!tab) throw new BrowserCommandFailure("TAB_NOT_FOUND", "Browser tab was not found in the selected Forge session.");

    if (command.type === "browser_tab_resize") {
      const input = viewportInput(command.viewport, command.tabId);
      const result = await service.invoke(command.sessionAgentId, profileId, "resize", input);
      if (!result.ok) throw new BrowserCommandFailure(result.error.code, result.error.message);
      const next = await service.getSessionSnapshot(profileId, command.sessionAgentId);
      sendSuccess(options, command, next);
      return;
    }

    const reported = cloneSnapshot(snapshot);
    if (command.type === "browser_tab_activate") {
      reported.activeTabId = command.tabId;
      reported.defaultTabId = command.tabId;
      reported.panelVisible = true;
    } else {
      reported.tabs = reported.tabs.filter((candidate) => candidate.tabId !== command.tabId);
      if (reported.activeTabId === command.tabId) reported.activeTabId = reported.tabs[0]?.tabId ?? null;
      if (reported.defaultTabId === command.tabId) reported.defaultTabId = reported.activeTabId;
    }
    const accepted = await service.reportHostState(connectionId, host.hostId, host.hostGeneration, [reported]);
    if (!accepted) throw new BrowserCommandFailure("STALE_HOST_GENERATION", "Browser host generation changed before the command completed.");
    const next = await service.getSessionSnapshot(profileId, command.sessionAgentId);
    sendSuccess(options, command, next);
  } catch (error) {
    const code = error instanceof BrowserCommandFailure ? error.code : "FAILED";
    sendFailure(options, command, code, error instanceof Error ? error.message : String(error));
  }
}

function sendSuccess(
  options: BrowserCommandHandlerOptions,
  command: Extract<BrowserClientCommand, { requestId: string }>,
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

class BrowserCommandFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

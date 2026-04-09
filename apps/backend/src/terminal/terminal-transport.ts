import type {
  TerminalCloseReason,
  TerminalDescriptor,
  TerminalResizeRequest,
} from "@forge/protocol";

export interface TerminalTransportAttachEvent {
  terminalId: string;
  sessionAgentId: string;
}

export interface TerminalTransportDetachEvent {
  terminalId: string;
  sessionAgentId: string;
}

export interface TerminalTransportInputEvent {
  terminalId: string;
  sessionAgentId: string;
  data: Buffer;
}

export interface TerminalTransportResizeEvent extends TerminalResizeRequest {
  terminalId: string;
}

export interface TerminalTransportCloseEvent {
  terminalId: string;
  sessionAgentId: string;
  reason?: TerminalCloseReason;
}

export type TerminalTransportInboundEvent =
  | { type: "attach"; payload: TerminalTransportAttachEvent }
  | { type: "detach"; payload: TerminalTransportDetachEvent }
  | { type: "input"; payload: TerminalTransportInputEvent }
  | { type: "resize"; payload: TerminalTransportResizeEvent }
  | { type: "close"; payload: TerminalTransportCloseEvent };

export type TerminalTransportOutboundEvent =
  | {
      type: "terminal_output";
      terminalId: string;
      sessionAgentId: string;
      seq: number;
      chunk: Buffer;
    }
  | {
      type: "terminal_exit";
      terminalId: string;
      sessionAgentId: string;
      exitCode: number | null;
      exitSignal: number | null;
    }
  | {
      type: "terminal_state";
      terminal: TerminalDescriptor;
    };

export interface TerminalTransport {
  subscribe(
    handler: (event: TerminalTransportInboundEvent) => Promise<void> | void,
  ): () => void;
  publish(event: TerminalTransportOutboundEvent): void;
  shutdown(): Promise<void>;
}

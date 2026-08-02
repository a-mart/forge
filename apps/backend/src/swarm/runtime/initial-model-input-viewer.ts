import type { AgentInitialModelInputState } from "@forge/protocol";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";
import { openSessionManagerWithSizeGuard } from "../session-file-guard.js";
import {
  findPiInitialModelInputCapture,
  findPiInitialModelInputCaptureInSessionEntries,
  PI_INITIAL_MODEL_INPUT_CAPTURE_ENTRY_TYPE,
} from "./initial-model-input-capture.js";

const PENDING: AgentInitialModelInputState = {
  status: "pending",
  message: "Available after the first model request.",
};

const UNSUPPORTED: AgentInitialModelInputState = {
  status: "unsupported",
  message: "Initial model-input capture is currently available for Pi runtimes only.",
};

/** Reads the first persisted Pi request without affecting runtime lifecycle. */
export function readInitialModelInputForViewer(
  descriptor: AgentDescriptor | undefined,
  runtime: SwarmAgentRuntime | undefined,
): AgentInitialModelInputState {
  if (!descriptor) return PENDING;
  if (descriptor.model.provider.trim().toLowerCase() === "cursor-sdk") return UNSUPPORTED;
  if (runtime?.runtimeType && runtime.runtimeType !== "pi") return UNSUPPORTED;

  try {
    const capture = runtime
      ? findPiInitialModelInputCapture(
          runtime.getCustomEntries(PI_INITIAL_MODEL_INPUT_CAPTURE_ENTRY_TYPE),
        )
      : findPiInitialModelInputCaptureInSessionEntries(
          openSessionManagerWithSizeGuard(descriptor.sessionFile, {
            context: "initial-model-input-viewer",
          })?.getEntries() ?? [],
        );
    return capture ? { status: "available", capture } : PENDING;
  } catch {
    // Viewer availability must not affect an active session or model request.
    return PENDING;
  }
}

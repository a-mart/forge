import type { CursorSdkModelSelection } from "./cursor-sdk-loader.js";
import type { AgentModelDescriptor } from "../../types.js";

const CURSOR_SDK_PROVIDER = "cursor-sdk";
const COMPOSER_25_MODEL_ID = "composer-2.5";
const CURSOR_THINKING_PARAM_ID = "thinking";
const SUPPORTED_CURSOR_THINKING_LEVELS = new Set(["low", "medium", "high"]);

export function toCursorSdkModelSelection(model: AgentModelDescriptor): CursorSdkModelSelection {
  if (model.provider.trim().toLowerCase() !== CURSOR_SDK_PROVIDER) {
    throw new Error(`Cursor SDK model selection requires provider cursor-sdk, received ${model.provider}.`);
  }

  if (model.modelId.trim() !== COMPOSER_25_MODEL_ID) {
    throw new Error(`Unsupported Cursor SDK model: ${model.modelId}.`);
  }

  return {
    id: COMPOSER_25_MODEL_ID,
    params: [
      {
        id: CURSOR_THINKING_PARAM_ID,
        value: normalizeCursorThinkingLevel(model.thinkingLevel)
      }
    ]
  };
}

export function normalizeCursorThinkingLevel(value: string | undefined): "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase() || "medium";
  if (SUPPORTED_CURSOR_THINKING_LEVELS.has(normalized)) {
    return normalized as "low" | "medium" | "high";
  }

  if (normalized === "none") {
    return "low";
  }

  if (normalized === "xhigh") {
    return "high";
  }

  throw new Error(`Unsupported Cursor SDK reasoning level: ${value}.`);
}

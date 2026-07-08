import { getCatalogModel } from "@forge/protocol";
import type { CursorSdkModelSelection } from "./cursor-sdk-loader.js";
import type { AgentModelDescriptor } from "../../types.js";

const CURSOR_SDK_PROVIDER = "cursor-sdk";
const COMPOSER_25_MODEL_ID = "composer-2.5";
const GROK_45_MODEL_ID = "grok-4.5";
const GROK_45_FAST_MODEL_ID = "grok-4.5-fast";
const CURSOR_FAST_PARAM_ID = "fast";
const CURSOR_EFFORT_PARAM_ID = "effort";
const SUPPORTED_CURSOR_EFFORT_LEVELS = new Set(["low", "medium", "high"]);

type CursorSdkModelDescriptor = Pick<AgentModelDescriptor, "provider" | "modelId"> & Partial<Pick<AgentModelDescriptor, "thinkingLevel">>;

export function toCursorSdkModelSelection(model: CursorSdkModelDescriptor): CursorSdkModelSelection {
  if (model.provider.trim().toLowerCase() !== CURSOR_SDK_PROVIDER) {
    throw new Error(`Cursor SDK model selection requires provider cursor-sdk, received ${model.provider}.`);
  }

  const normalizedModelId = model.modelId.trim().toLowerCase();
  switch (normalizedModelId) {
    case COMPOSER_25_MODEL_ID:
      return {
        id: COMPOSER_25_MODEL_ID,
        params: [{ id: CURSOR_FAST_PARAM_ID, value: "true" }]
      };
    case GROK_45_MODEL_ID:
      return toGrok45ModelSelection(model, { fast: false });
    case GROK_45_FAST_MODEL_ID:
      return toGrok45ModelSelection(model, { fast: true });
    default:
      throw new Error(`Unsupported Cursor SDK model: ${model.modelId}.`);
  }
}

export function normalizeCursorThinkingLevel(value: string | undefined, modelId = GROK_45_MODEL_ID): "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase() || getDefaultCursorEffortLevel(modelId);
  if (SUPPORTED_CURSOR_EFFORT_LEVELS.has(normalized)) {
    return normalized as "low" | "medium" | "high";
  }

  if (normalized === "none") {
    return "low";
  }

  if (normalized === "xhigh" || normalized === "x-high") {
    return "high";
  }

  throw new Error(`Unsupported Cursor SDK reasoning level: ${value}.`);
}

function toGrok45ModelSelection(model: CursorSdkModelDescriptor, options: { fast: boolean }): CursorSdkModelSelection {
  return {
    id: GROK_45_MODEL_ID,
    params: [
      {
        id: CURSOR_EFFORT_PARAM_ID,
        value: normalizeCursorThinkingLevel(model.thinkingLevel, model.modelId)
      },
      {
        id: CURSOR_FAST_PARAM_ID,
        value: options.fast ? "true" : "false"
      }
    ]
  };
}

function getDefaultCursorEffortLevel(modelId: string): "low" | "medium" | "high" {
  const catalogDefault = getCatalogModel(modelId, CURSOR_SDK_PROVIDER)?.defaultReasoningLevel;
  if (catalogDefault === "low" || catalogDefault === "medium" || catalogDefault === "high") {
    return catalogDefault;
  }
  if (catalogDefault === "none") {
    return "low";
  }
  return "high";
}

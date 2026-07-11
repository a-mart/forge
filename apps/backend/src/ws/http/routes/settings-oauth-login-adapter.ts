import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type {
  SettingsAuthLoginEventName,
  SettingsAuthLoginEventPayload,
} from "@forge/protocol";

/** Marker prefix so new clients can ignore old-client compatibility fallbacks. */
export const OAUTH_LEGACY_DEVICE_CODE_FALLBACK_MARKER = "[forge-oauth-legacy-fallback:device_code]";
export const OAUTH_LEGACY_SELECT_FALLBACK_MARKER = "[forge-oauth-legacy-fallback:select]";

type SendSettingsAuthLoginSseEvent = <TEventName extends SettingsAuthLoginEventName>(
  eventName: TEventName,
  data: SettingsAuthLoginEventPayload[TEventName],
) => void;

export type SettingsAuthOAuthPromptRequest = {
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string }>;
};

/**
 * Shared Pi OAuth callback adapter for direct and pool login routes.
 * Emits additive device_code/select events plus marked legacy auth_url/prompt fallbacks.
 */
export function createSettingsAuthOAuthLoginCallbacks(args: {
  sendSseEvent: SendSettingsAuthLoginSseEvent;
  requestPromptInput: (prompt: SettingsAuthOAuthPromptRequest) => Promise<string | undefined>;
  signal: AbortSignal;
  usesCallbackServer: boolean;
}): OAuthLoginCallbacks {
  const { sendSseEvent, requestPromptInput, signal, usesCallbackServer } = args;

  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => {
      sendSseEvent("auth_url", {
        url: info.url,
        instructions: info.instructions,
      });
    },
    onDeviceCode: (info) => {
      sendSseEvent("device_code", {
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        intervalSeconds: info.intervalSeconds,
        expiresInSeconds: info.expiresInSeconds,
      });
      // Old clients only understand auth_url; include the user code in instructions.
      sendSseEvent("auth_url", {
        url: info.verificationUri,
        instructions: `${OAUTH_LEGACY_DEVICE_CODE_FALLBACK_MARKER} Enter device code ${info.userCode} at ${info.verificationUri}`,
      });
    },
    onPrompt: (prompt) =>
      requestPromptInput({
        message: prompt.message,
        placeholder: prompt.placeholder,
      }).then((value) => value ?? ""),
    onSelect: (prompt) =>
      requestPromptInput({
        message: prompt.message,
        options: prompt.options,
      }),
    onProgress: (message) => {
      sendSseEvent("progress", { message });
    },
    signal,
  };

  if (usesCallbackServer) {
    callbacks.onManualCodeInput = () =>
      requestPromptInput({
        message: "Paste redirect URL below, or complete login in browser:",
        placeholder: "http://localhost:1455/auth/callback?code=...",
      }).then((value) => value ?? "");
  }

  return callbacks;
}

/**
 * Emit prompt or select (+ marked prompt fallback) with a shared requestId.
 */
export function emitSettingsAuthOAuthPromptEvents(args: {
  sendSseEvent: SendSettingsAuthLoginSseEvent;
  requestId: string;
  prompt: SettingsAuthOAuthPromptRequest;
}): void {
  const { sendSseEvent, requestId, prompt } = args;
  if (prompt.options && prompt.options.length > 0) {
    sendSseEvent("select", {
      requestId,
      message: prompt.message,
      options: prompt.options,
    });
    const optionLines = prompt.options.map((option) => `- ${option.id}: ${option.label}`).join("\n");
    sendSseEvent("prompt", {
      requestId,
      message: `${OAUTH_LEGACY_SELECT_FALLBACK_MARKER}\n${prompt.message}\nOptions:\n${optionLines}`,
      placeholder: prompt.options[0]?.id,
    });
    return;
  }

  sendSseEvent("prompt", {
    requestId,
    message: prompt.message,
    placeholder: prompt.placeholder,
  });
}

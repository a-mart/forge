import {
  configureXaiOAuthProxyClient,
  getXaiOAuthProxyHeaders,
  XAI_GROK_PROXY_COMPATIBILITY_SOURCE,
  XAI_GROK_PROXY_COMPATIBILITY_VERSION,
} from "@earendil-works/pi-ai/oauth";
import { getForgeAppVersion } from "../../utils/app-version.js";

export {
  XAI_GROK_PROXY_COMPATIBILITY_SOURCE,
  XAI_GROK_PROXY_COMPATIBILITY_VERSION,
};

/** Configure Pi's OAuth model transform with Forge's actual package version. */
export function configureForgeXaiOAuthProxyClient(): void {
  configureXaiOAuthProxyClient(getForgeAppVersion());
}

/**
 * Proxy-only headers shared by inference and authenticated model discovery.
 * A model ID is supplied only for inference, where the proxy routes by override.
 */
export function getForgeXaiOAuthProxyHeaders(modelId?: string): Record<string, string> {
  configureForgeXaiOAuthProxyClient();
  return getXaiOAuthProxyHeaders(modelId ? { modelId } : undefined);
}

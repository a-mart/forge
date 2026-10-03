import {
  ChatArtifactError,
  authorizePresentedChatArtifactTarget,
  chatArtifactStatus,
  type PresentedArtifactOwnerSource,
} from "../../../swarm/session/presented-chat-artifact.js";
import {
  HtmlArtifactPreviewError,
  type HtmlArtifactPreviewStore,
  htmlArtifactPreviewStatus,
} from "../../../swarm/session/html-artifact-preview.js";
import { resolveReadFilePath, type FileAccessSource } from "../../ws-file-access.js";

const ISSUE_KEYS = new Set(["path", "agentId", "transcriptAgentId", "messageId"]);

export type HtmlArtifactPreviewSource = FileAccessSource & PresentedArtifactOwnerSource;

/**
 * Shared by HTTP and the WS api_proxy. Read-access authorization follows each
 * surface's existing read-file rule; over WS the transcript owner is the
 * subscribed session rather than a caller-supplied id.
 */
export async function issueHtmlArtifactPreview(options: {
  source: HtmlArtifactPreviewSource;
  store: HtmlArtifactPreviewStore;
  payload: unknown;
  authBinding?: string;
  subscribedAgentId?: string;
  includeCwdAllowlistRootsForAgent: boolean;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { payload } = options;
  if (
    !payload || typeof payload !== "object" || Array.isArray(payload) ||
    Object.keys(payload).some((key) => !ISSUE_KEYS.has(key))
  ) return invalidHtmlArtifactPreviewRequest();
  const { path, agentId, transcriptAgentId, messageId } = payload as Record<string, unknown>;
  if (typeof path !== "string" || !path.trim()) return invalidHtmlArtifactPreviewRequest();
  if (agentId !== undefined && typeof agentId !== "string") return invalidHtmlArtifactPreviewRequest();

  try {
    let authorized: string;
    if (messageId !== undefined) {
      const owner = options.subscribedAgentId ?? transcriptAgentId;
      if (typeof messageId !== "string" || typeof owner !== "string") return invalidHtmlArtifactPreviewRequest();
      authorized = await authorizePresentedChatArtifactTarget(options.source, { transcriptAgentId: owner, messageId, path });
    } else {
      authorized = await resolveReadFilePath(path, options.source, agentId?.trim() || undefined, {
        includeCwdAllowlistRootsForAgent: options.includeCwdAllowlistRootsForAgent,
      });
    }
    const preview = await options.store.issue(authorized, options.authBinding);
    return { status: 200, body: { ...preview } };
  } catch (error) {
    if (error instanceof HtmlArtifactPreviewError) {
      return { status: htmlArtifactPreviewStatus(error.code), body: { error: error.code, code: error.code } };
    }
    if (error instanceof ChatArtifactError) {
      return { status: chatArtifactStatus(error.code), body: { error: error.code, code: error.code } };
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("outside allowed roots") || message.includes("Unknown agent")) {
      return { status: 403, body: { error: "forbidden", code: "forbidden" } };
    }
    return { status: 500, body: { error: "Unable to prepare HTML preview.", code: "preview_failed" } };
  }
}

export function invalidHtmlArtifactPreviewRequest(): { status: number; body: Record<string, unknown> } {
  return { status: 400, body: { error: "invalid_request", code: "invalid_request" } };
}


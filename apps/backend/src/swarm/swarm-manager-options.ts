import type { ObservabilityFacade } from "../observability/observability-types.js";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import type { BrowserAutomationService } from "./browser-automation/browser-automation-service.js";
import type { CodexAppServerService } from "./codex-app-server/codex-app-server-service.js";
import type { CodexAppServerServiceOptions } from "./codex-app-server/types.js";
import type { CompactionRuntimeSettingsProvider } from "./compaction-runtime-settings-provider.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import type {
  ExternalThreadStopInterruptCallback,
  ExternalThreadTerminateCleanupCallback,
} from "./swarm-agent-lifecycle-service.js";

/** Optional composition seams for the SwarmManager application root. */
export interface SwarmManagerOptions {
  now?: () => string;
  versioningService?: VersioningMutationSink;
  observability?: ObservabilityFacade;
  codexAppServerService?: CodexAppServerService;
  codexAppServerServiceOptions?: CodexAppServerServiceOptions;
  /** Stop-only seam for preserved sidecars; defaults to CodexAppServerService.interruptTurn(). */
  interruptExternalThreadSidecarTurn?: ExternalThreadStopInterruptCallback;
  /** Kill/delete cleanup-only seam. Distinct from stop interrupts; defaults to Codex cleanup. */
  terminateExternalThreadSidecarTurn?: ExternalThreadTerminateCleanupCallback;
  compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
  knowledgeV2SettingsService?: KnowledgeV2SettingsService;
  knowledgeService?: KnowledgeService;
  browserAutomationService?: BrowserAutomationService;
}

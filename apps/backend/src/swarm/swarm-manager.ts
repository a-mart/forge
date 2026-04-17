import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type {
  AgentRuntimeExtensionSnapshot,
  ChoiceRequestEvent,
  CredentialPoolState,
  CredentialPoolStrategy,
  PooledCredentialInfo,
  CortexReviewRunRecord,
  CortexReviewRunScope,
  CortexReviewRunTrigger,
  PromptPreviewResponse,
  ServerEvent,
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
  SessionMeta,
  SkillFileContentResponse,
  SkillFilesResponse,
  SkillInventoryEntry
} from "@forge/protocol";
import { persistConversationAttachments } from "../ws/attachment-parser.js";
import type { VersioningMutation, VersioningMutationSink } from "../versioning/versioning-types.js";
import {
  FileBackedPromptRegistry,
  normalizeArchetypeId,
  resolvePromptVariables,
  type PromptCategory,
  type PromptRegistry
} from "./prompt-registry.js";
import { ConversationProjector } from "./conversation-projector.js";
import {
  getCommonKnowledgePath,
  getCortexPromotionManifestsDir,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getCortexWorkerPromptsPath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getSessionDir,
  getSessionFilePath,
  getWorkerSessionFilePath,
  getWorkersDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import {
  clearAllPins as clearAllSessionPins,
  combineCompactionCustomInstructions,
  formatPinnedMessagesForCompaction,
  loadPins,
  savePins,
  togglePin,
  type PinRegistry
} from "./message-pins.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { backendSidebarPerfMetricManifest } from "../stats/sidebar-perf-metrics.js";
import { createSidebarPerfRegistry } from "../stats/sidebar-perf-registry.js";
import type {
  SidebarConversationHistoryDiagnostics,
  SidebarPerfRecorder,
  SidebarPerfSlowEvent,
  SidebarPerfSummary
} from "../stats/sidebar-perf-types.js";
import type { CredentialPoolService } from "./credential-pool.js";
import { migrateDataDirectory } from "./data-migration.js";
import { cleanupOldSharedConfigPaths, migrateSharedConfigLayout } from "./shared-config-migration.js";
import {
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext
} from "./agent-creator-context.js";
import {
  analyzeSessionForPromotion,
  type AnalyzeSessionForPromotionOptions,
  type ProjectAgentRecommendations
} from "./project-agent-analysis.js";
import { deleteProjectAgentRecord, reconcileProjectAgentStorage } from "./project-agent-storage.js";
import {
  deliverProjectAgentMessage,
  findProjectAgentByHandle,
  formatProjectAgentRuntimeMessage,
  getProjectAgentHandleCollisionError,
  getProjectAgentPublicName,
  normalizeProjectAgentHandle,
  normalizeProjectAgentInlineText
} from "./project-agents.js";
import { PersistenceService } from "./persistence-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import type { VersioningCommitEvent as ForgeVersioningCommitEvent } from "./forge-extension-types.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import { generatePiProjection } from "./model-catalog-projection.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { CLAUDE_RUNTIME_STATE_ENTRY_TYPE } from "./claude-agent-runtime.js";
import {
  appendModelChangeContinuityApplied,
  createModelChangeContinuityApplied,
  type ModelChangeContinuityRequest
} from "./runtime/model-change-continuity.js";
import { resolvePendingModelChangeRuntimeStartup } from "./runtime/model-change-runtime-startup.js";
import {
  SwarmRuntimeController,
  type SwarmRuntimeControllerHost
} from "./swarm-runtime-controller.js";
import { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import {
  SwarmWorkerHealthService,
  type WatchdogBatchEntry,
  type WorkerActivityState,
  type WorkerStallState,
  type WorkerWatchdogState
} from "./swarm-worker-health-service.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { SwarmMemoryMergeService, type SessionMemoryMergeAuditEntry } from "./swarm-memory-merge-service.js";
import { SwarmSessionMetaService, type SessionMemoryMergeAttemptMetaUpdate } from "./swarm-session-meta-service.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import { SwarmChoiceService } from "./swarm-choice-service.js";
import { SwarmCortexService } from "./swarm-cortex-service.js";
import { SwarmPromptService } from "./swarm-prompt-service.js";
import { SwarmSettingsService } from "./swarm-settings-service.js";
import {
  SwarmAgentLifecycleService,
  type AgentLifecycleStopSessionOptions,
  type ManagerRuntimeRecycleReason
} from "./swarm-agent-lifecycle-service.js";
import { SessionProvisioner } from "./session-provisioner.js";
import { SwarmSessionService } from "./swarm-session-service.js";
import { SwarmProjectAgentService } from "./swarm-project-agent-service.js";
import {
  normalizeAllowlistRoots,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import {
  isConversationBinaryAttachment,
  isConversationImageAttachment,
  isConversationTextAttachment
} from "./conversation-validators.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isAbortLikeErrorMessage,
  normalizeProviderErrorMessage
} from "./message-utils.js";
import { classifyRuntimeCapacityError } from "./runtime-utils.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  parseSwarmModelPreset,
  parseSwarmReasoningLevel,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import { loadOnboardingState } from "./onboarding-state.js";
import {
  generateRosterBlock as specialistGenerateRosterBlock,
  getSpecialistsEnabled as specialistGetSpecialistsEnabled,
  LEGACY_MODEL_ROUTING_GUIDANCE,
  normalizeSpecialistHandle as specialistNormalizeSpecialistHandle,
  resolveRoster as specialistResolveRoster,
} from "./specialists/specialist-registry.js";
import {
  isNonRunningAgentStatus,
  transitionAgentStatus
} from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  SetPinnedContentOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type {
  AgentMessageEvent,
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  ChoiceAnswer,
  ChoiceQuestion,
  ChoiceRequestStatus,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ManagerProfile,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SessionLifecycleEvent,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset,
  SwarmReasoningLevel
} from "./types.js";
import {
  buildModelCapacityBlockKey,
  clampModelCapacityBlockDurationMs,
  cloneDescriptor,
  cloneProjectAgentInfoValue,
  extractDescriptorAgentId,
  extractRuntimeMessageText,
  formatBinaryAttachmentForPrompt,
  formatInboundUserMessageForManager,
  formatTextAttachmentForPrompt,
  isEnoentError,
  isRecord,
  normalizeAgentId,
  normalizeContextUsage,
  normalizeConversationAttachments,
  normalizeCortexUserVisiblePaths,
  normalizeMessageSourceContext,
  normalizeMessageTargetContext,
  normalizeOptionalAgentId,
  normalizeOptionalAttachmentPath,
  normalizeOptionalModelId,
  nowIso,
  parseCompactSlashCommand,
  normalizeThinkingLevelForProvider,
  parseSessionNumberFromAgentId,
  previewForLog,
  readFileHead,
  sanitizeAttachmentFileName,
  sanitizePathSegment,
  slugifySessionName,
  toConversationAttachmentMetadata,
  toRuntimeDispatchAttachments,
  toRuntimeImageAttachments,
  validateAgentDescriptor
} from "./swarm-manager-utils.js";

export {
  analyzeLatestCortexCloseoutNeed,
  buildSessionMemoryRuntimeView,
  normalizeCortexUserVisiblePaths
} from "./swarm-manager-utils.js";

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  displayName: string;
  color: string;
  enabled: boolean;
  whenToUse: string;
  modelId: string;
  provider: string;
  reasoningLevel?: SwarmReasoningLevel;
  fallbackModelId?: string;
  fallbackProvider?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
  webSearch?: boolean;
  promptBody: string;
  available: boolean;
  availabilityCode?: string;
  availabilityMessage?: string;
}

interface SpecialistRegistryModule {
  resolveRoster(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[]): string;
  normalizeSpecialistHandle(value: string): string;
  getSpecialistsEnabled(): Promise<boolean>;
  legacyModelRoutingGuidance: string;
}

// AgentDescriptor now includes specialistId/specialistDisplayName/specialistColor directly.


const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const CORTEX_DISPLAY_NAME = "Cortex";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this specific project/profile.

Cortex may already have captured durable cross-project user defaults such as preferred name, technical level, and response preferences.
If an onboarding snapshot or onboarding-derived summary is present in injected context, treat that as authoritative over any rendered natural-language copy.

Do NOT re-run a generic user onboarding interview.
Do NOT ask broad user-level questions like:
- what they like to be called
- whether they prefer concise or detailed responses in general
- whether they prefer autonomy or collaboration in general
- what explanation depth they want in general
unless that information is truly missing and directly necessary for the immediate work.

Important honesty rule:
- If onboarding defaults are actually present, you may briefly acknowledge that you already have a baseline sense of how they like to work.
- If onboarding was skipped, is still pending, or is effectively empty, do NOT imply that you already know their preferences.
- In that case, stay project-focused and let Cortex handle cross-project preferences later.

Your first job is to orient to THIS project.

Send a warm welcome. Then run a short, practical, project bootstrap conversation focused on:
1. What they are building or trying to accomplish here.
2. Which repo, directory, or codebase is the source of truth.
3. The project stack and architecture, if not obvious from files.
4. Validation commands and quality gates.
5. Repo-specific conventions, constraints, workflows, or guardrails.
6. Docs or guidance you should read first.
7. What they want to do first.

Keep this conversational, not checklist-like.
Ask only the next most useful question.
If the user arrives with a concrete task, get enough bootstrap context to work safely, then move into execution.

Prefer repo inspection over interrogation.
Start by reading these in order when they exist and are relevant:
1. AGENTS.md / SWARM.md / repo-specific agent instructions
2. README.md or top-level docs for project overview
3. package.json / pnpm-workspace.yaml / pyproject.toml / Cargo.toml / go.mod / equivalent manifests
4. build, test, lint, typecheck, or task-runner config
5. CONTRIBUTING.md, docs/DEVELOPMENT.md, or similar contributor guidance

Ask the user only for what you cannot infer confidently from those materials.
Distinguish durable repo conventions from one-off task details.
Do not collapse project-specific rules into cross-project user defaults.

Useful first-message shapes:
- If onboarding defaults are present: "Hi - I already have a baseline sense of how you like to work, so I'll focus on this project. What are we building here, and which repo or directory should I treat as the source of truth?"
- If onboarding defaults are absent: "Hi - I'll focus on getting oriented to this project. What are we building here, and which repo or directory should I treat as the source of truth?"

Do not include the old generic "how do you like to work" interview.
This manager's onboarding is about the project, not the person.`;
const COMMON_KNOWLEDGE_INITIAL_TEMPLATE = `# Common Knowledge
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Interaction Defaults

## Workflow Defaults

## Cross-Project Technical Standards

## Cross-Project Gotchas
`;

const CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE = `# Cortex Worker Prompt Templates — v4
<!-- Cortex Worker Prompts Version: 4 -->

> Owned by Cortex. Refine these templates over time based on what produces good vs bad results from workers.

Use these templates when spawning workers. Copy the relevant template, fill in the placeholders (marked with \`{{...}}\`), and send as the worker's task message.

Model-selection guidance:
- Cortex chooses the actual runtime model.
- Default to a cheap/fast extraction model for narrow transcript work.
- Retry with a more reliable balanced model if the fast path idles or emits no output.
- Escalate to a deep-synthesis model for ambiguity, conflict resolution, or large reconciliation passes.

---

## Promotion Discipline (all templates)

Default to **precision over coverage**.

- A clean **no durable findings** result is good work.
- Prefer **discard** over weak promotion.
- Prefer **note** over weak \`inject\` / \`reference\` proposals.
- Prefer **reference** over **inject** for narrow procedures, command catalogs, troubleshooting flows, and task-local runbooks.
- Only use **inject** when the finding should change future agent behavior by default within its scope.
- Distill findings into future-facing guidance. Do not copy transcript chronology, long command sequences, or logs unless the exact string is itself the durable convention.
- Cap retained findings to the strongest few. Merge overlaps instead of emitting near-duplicates.
- Prioritize explicit user statements, trusted artifacts, explicit feedback, and repeated user-side patterns over assistant chatter.

## Evidence Discipline (all templates)

Prefer **exogenous evidence** over **endogenous evidence**.

Stronger evidence:
- explicit user instructions or corrections
- trusted source-of-truth artifacts (\`AGENTS.md\`, stable design docs, configs)
- explicit feedback telemetry
- repeated user-side patterns across sessions

Weaker evidence:
- manager/worker behavior that may have been shaped by existing memory
- assistant narrative claims
- session-memory text by itself
- one-off inferences from ambiguous context

Rules:
- Do not propose weak evidence directly for \`common\` injected memory.
- Treat session memory as supporting evidence, not authoritative truth.
- If a signal is interesting but weak, return it as \`note\`.

## Required Finding Schema (all extraction templates)

Write markdown, but include one fenced \`json\` block containing this normalized shape:

\`\`\`json
{
  "profile": "<profileId>",
  "session": "<sessionId>",
  "source_kind": "transcript | session_memory | feedback",
  "findings": [
    {
      "id": "F1",
      "statement": "atomic durable claim",
      "type": "preference | workflow | decision | fact | gotcha | procedure | feedback",
      "proposed_outcome": "note | inject | reference | discard",
      "proposed_target": "common | profile_memory | reference/<file>.md | notes | none",
      "scope": "common | profile",
      "confidence": "high | medium | low",
      "evidence_tier": "explicit_user | trusted_artifact | feedback_signal | repeated_user_pattern | agent_inference",
      "sources": [
        { "kind": "session_message | session_memory | feedback | doc", "ref": "..." }
      ],
      "rationale": "why this routing is appropriate"
    }
  ],
  "summary": {
    "finding_count": 0,
    "blockers": []
  }
}
\`\`\`

Schema rules:
- cap retained findings to the strongest 8 unless the task explicitly asks for fewer
- prefer atomic claims rather than bundled paragraphs
- return empty \`findings\` if nothing durable exists
- do not substitute a prose session summary for structured findings

---

## Callback Format (all templates)

Every worker MUST send a final callback to the manager via \`send_message_to_agent\` in this format:

\`\`\`
STATUS: DONE | FAILED
FINDINGS: <count>
ARTIFACT: <path to output file>
BLOCKER: <none | brief description>
\`\`\`

Detailed reasoning and full findings go in the output artifact file, NOT in the callback message.

---

## 1. Session Transcript Extraction Worker

Use for: Reviewing a single session's transcript delta and extracting durable knowledge signals.

\`\`\`
You are a knowledge extraction worker for Cortex.

## Task
Review only the transcript delta that starts at byte offset {{BYTE_OFFSET}} in \`{{SESSION_JSONL_PATH}}\`.

Important: the \`read\` tool offset is line-based, NOT byte-based. Do NOT pass {{BYTE_OFFSET}} into \`read\` directly.

Use this workflow:
1. If \`{{BYTE_OFFSET}}\` is greater than 0, use \`bash\` with Python/Node to copy the transcript slice starting at byte offset {{BYTE_OFFSET}} into \`{{DELTA_SLICE_PATH}}\`.
2. Read \`{{DELTA_SLICE_PATH}}\` with the \`read\` tool.
3. If \`{{BYTE_OFFSET}}\` is 0, you may read the original session file directly.

The file is JSONL. Prioritize \`user_message\` entries, then explicit decisions or conventions stated elsewhere. Treat assistant behavior that may have been shaped by existing memory as weak evidence.

## Extract only durable signals
Examples:
- user preferences
- workflow patterns
- technical decisions
- project facts
- quality standards
- working conventions
- recurring gotchas
- cross-project patterns

## Skip
- transient task details
- implementation minutiae
- secrets
- ephemeral progress chatter
- raw code unless it clearly reveals a durable convention
- long runbooks unless the exact command/name is itself the durable convention

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Why:\` one short paragraph
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "transcript"\`
4. \`Discarded candidates\` with brief bullets for tempting but weak/transient signals
5. \`Concise completion summary\` with 1-3 bullets Cortex could reuse in a user closeout

Additional rules:
- At most 8 retained findings.
- Use \`note\` when the signal is plausible but not strong enough to promote.
- Do not promote weak evidence directly to \`common\`.
- Do not summarize the whole session.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 2. Session-Memory Extraction Worker

Use for: Reviewing a session working-memory file for signals worth promoting or preserving as notes.

\`\`\`
You are a session-memory review worker for Cortex.

## Task
Read the session memory file at \`{{SESSION_MEMORY_PATH}}\`.

For context, the current profile memory is:
{{PROFILE_MEMORY_CONTENT_OR "Profile memory is currently empty."}}

## Evidence rule
Session memory is supporting evidence, not authoritative truth. If a claim is interesting but not independently strong, return it as \`note\`.

## What to look for
- durable decisions or conventions
- corrections to existing profile memory
- architecture/gotcha signals worth remembering
- patterns not yet captured in profile memory

## What to skip
- active task state and in-progress work items
- duplicates of existing profile memory
- speculative notes without support
- Cortex-internal orchestration details
- long procedural detail better suited for reference

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Why:\` one short paragraph
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "session_memory"\`
4. \`Discarded candidates\`
5. \`Concise completion summary\`

Additional rules:
- Prefer \`note\` when the signal is not independently confirmed.
- Default target is \`profile_memory\`, \`reference/<file>.md\`, or \`notes\`.
- Do not create common injected lore from session memory alone.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 3. Knowledge Synthesis Worker

Use for: Deduplicating multiple worker artifacts into promotion-ready actions.

\`\`\`
You are a knowledge synthesis worker for Cortex.

## Task
Below are raw findings from multiple worker artifacts. Deduplicate, reconcile conflicts, and produce promotion-ready actions.

## Raw findings
{{PASTE_ALL_WORKER_FINDINGS_HERE}}

## Current knowledge state
{{PASTE_RELEVANT_EXISTING_KNOWLEDGE_OR "No existing entries — all findings are new."}}

## Instructions
1. Deduplicate overlapping findings.
2. Reconcile conflicts and flag tensions explicitly.
3. Keep only findings that add new durable signal.
4. Validate each retained finding's proposed outcome and target.
5. Prefer no-op over marginal promotion.

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Recommended Actions (JSON)\` in this shape:

\`\`\`json
{
  "actions": [
    {
      "action": "add_note | promote_to_inject | promote_to_reference | update_entry | retire_entry | merge_duplicate | no_change",
      "target_file": "relative/path.md | notes | none",
      "target_section": "section name or managed block",
      "finding_ids": ["F1"],
      "confidence": "high | medium | low",
      "conflict_status": "none | tension | blocked",
      "proposed_text": "concise future-facing text",
      "reason": "why this action is appropriate"
    }
  ],
  "summary": {
    "promote_count": 0,
    "note_count": 0,
    "discard_count": 0,
    "blockers": []
  }
}
\`\`\`

3. \`Discarded / no-op findings\`
4. \`Open tensions or blockers\`
5. \`Concise completion summary\` with 2-4 bullets Cortex can adapt into a short user-facing completion

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 4. Scan / Triage Worker (fallback only)

Use for: Optional fallback when Cortex cannot safely run the bounded scan directly.

\`\`\`
You are a scan and triage worker for Cortex.

## Task
Only use this worker if Cortex explicitly asked for delegated scan help. Cortex normally runs the bounded scan itself.

1. Execute: \`bash node {{SWARM_SCRIPTS_DIR}}/cortex-scan.js {{SWARM_DATA_DIR}}\`
2. Parse transcript, memory, and feedback drift.
3. Sort by the requested priority rule.

## Output
Write results to \`{{OUTPUT_ARTIFACT_PATH}}\`:
- \`Review Queue\` table
- \`Summary\` bullets
- \`Notable priority drivers\`

Do NOT read any session files.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 5. Feedback Telemetry Worker (programmatic-first)

Use for: Feedback-system reviews where you want structured signal without reading whole sessions manually.

\`\`\`
You are a feedback telemetry worker for Cortex.

## Task
Use scripts and structured outputs first.

1. Run one or more telemetry scripts as needed:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-review-queue.js {{SWARM_DATA_DIR}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-session-digest.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-global-summary.js {{SWARM_DATA_DIR}}\`
2. Identify high-signal anomalies.
3. Only if needed, run targeted context extraction:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-target-context.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}} --target {{TARGET_ID}}\`

## Output
Write markdown to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
1. \`Outcome: promote | no-op | follow-up-needed\`
2. \`Programmatic digest\`
3. \`Candidate Findings (JSON)\` containing the required normalized schema with:
   - \`profile: "{{PROFILE_ID}}"\`
   - \`session: "{{SESSION_ID}}"\`
   - \`source_kind: "feedback"\`
4. \`Data quality issues\`
5. \`Concise completion summary\`

Additional rules:
- Allow \`note\` when feedback reveals a plausible pattern but not a promotion-ready one.
- Treat explicit negative/positive feedback as stronger evidence than assistant narration.
- Never include secrets.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 6. Orchestration Kickoff Worker

Use for: Planning a review cycle from scan results.

\`\`\`
You are an orchestration planning worker for Cortex.

## Task
Given scan results, produce a concrete execution plan.

## Scan results
{{SCAN_RESULTS_OR_ARTIFACT_CONTENT}}

## Constraints
- Max concurrent workers: {{MAX_WORKERS | default: 5}}
- Use the current fast extraction default first.
- Prefer balanced fallback for reliability retries.
- Escalate to deep-synthesis model only for ambiguity/high-complexity work.

## Output
Write plan to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
- execution batches
- risk flags
- synthesis plan
- likely no-op targets vs likely promotion/note targets

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 7. Deep Audit Worker

Use for: Auditing knowledge files for stale entries, scope drift, contradictions, and bloat.

\`\`\`
You are a knowledge audit worker for Cortex.

## Task
Audit the listed knowledge files for quality and scope correctness.

## Files to audit
{{LIST_OF_FILES_TO_AUDIT}}

## Current file contents
{{PASTE_FILE_CONTENTS_HERE}}

## Output
Write audit results to \`{{OUTPUT_ARTIFACT_PATH}}\`.
For each issue include:
- **Entry**
- **Issue type**: stale | scope-drift | contradiction | vague | bloated | missing-link
- **Recommendation**: update | move | remove | sharpen | split-to-reference | demote-to-note
- **Detail**

End with:
- **Top priority fixes**: max 5 bullets
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 8. Prune / Retirement Worker

Use for: Identifying knowledge entries that should be retired or demoted from inject to reference/note.

\`\`\`
You are a knowledge pruning worker for Cortex.

## Task
Review the knowledge file below and identify entries that should be retired, demoted, archived, or sharpened.

## File to prune
Path: {{FILE_PATH}}
Contents:
{{FILE_CONTENTS}}

## Recent evidence
{{RECENT_EVIDENCE_SUMMARY_OR "No recent evidence provided."}}

## Output
Write recommendations to \`{{OUTPUT_ARTIFACT_PATH}}\`.
For each entry include:
- **Action**: retire | demote-to-reference | demote-to-note | archive | sharpen
- **Rationale**
- **Replacement text**: (if sharpen)

End with:
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 9. Migration / Reclassification Worker

Use for: Migrating legacy \`shared/knowledge/profiles/<profileId>.md\` content into the v2 structure.

\`\`\`
You are a knowledge migration worker for Cortex.

## Task
Reclassify the legacy profile knowledge file into \`note | inject | reference | discard\` outputs.

## Legacy file
Path: {{LEGACY_FILE_PATH}}
Contents:
{{LEGACY_FILE_CONTENTS}}

## Current v2 state
Profile memory (\`profiles/{{PROFILE_ID}}/memory.md\`):
{{PROFILE_MEMORY_CONTENTS_OR "Empty — not yet created."}}

Reference docs exist: {{REFERENCE_DOCS_LIST_OR "None yet."}}

## Output
Write migration recommendations to \`{{OUTPUT_ARTIFACT_PATH}}\` with sections:
- \`Outcome: promote | no-op | follow-up-needed\`
- \`Candidate Findings (JSON)\` using the required schema (\`source_kind\` may be \`doc\` in \`sources\`)
- \`Migration summary\`
- \`Concise completion summary\`

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## Usage Notes

- Cortex normally runs the bounded scan itself.
- Use template 1 for transcript deltas.
- Use template 2 when session memory drift exists.
- Use template 3 when 3+ workers need synthesis or when shard reconciliation is needed.
- Use template 4 only as fallback for delegated scan help.
- Use template 5 for feedback-specific analysis.
- Use template 6 for large review-cycle planning.
- Use template 7 periodically for quality audits.
- Use template 8 when injected knowledge grows stale or bloated.
- Use template 9 for legacy-profile-knowledge migration/reclassification.
- Every template requires the concise callback.
- Workers propose \`note | inject | reference | discard\`; Cortex validates before promotion.
- No-op is a first-class outcome. Clean closure beats noisy promotion.
`;

const CORTEX_WORKER_PROMPTS_VERSION_MARKER = "<!-- Cortex Worker Prompts Version: 4 -->";
const PREVIOUS_CORTEX_WORKER_PROMPTS_VERSION_MARKERS = ["<!-- Cortex Worker Prompts Version: 3 -->", "<!-- Cortex Worker Prompts Version: 2 -->"] as const;
const LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES = [
  "# Cortex Worker Prompt Templates",
  "Read the session file at \\`{{SESSION_JSONL_PATH}}\\` starting from byte offset {{BYTE_OFFSET}}",
  "Return your findings as a structured list.",
  "Workers report back via \\`worker_message\\`."
] as const;

const FORKED_SESSION_MEMORY_HEADER_TEMPLATE = [
  "# Session Memory",
  '> Forked from session "' + "$" + "{SOURCE_LABEL}" + '" (' + "$" + "{SOURCE_AGENT_ID}" + ") on " + "$" + "{FORK_TIMESTAMP}",
  "> " + "$" + "{FORK_HISTORY_NOTE}",
  ""
].join("\n");

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;
// Retain recent non-web activity while preserving the full user-facing web transcript.
// Integration services add ~2 event listeners per profile (Telegram conversation_message,
// Telegram session_lifecycle). Keep this limit above base listeners +
// (2 × expected maximum profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS = 15_000;
const MODEL_CAPACITY_BLOCK_DEFAULT_MS = 10 * 60_000;
const SESSION_ID_SUFFIX_SEPARATOR = "--s";
const ROOT_SESSION_NUMBER = 1;

export { ChoiceRequestCancelledError } from "./swarm-choice-service.js";

interface SessionRenameHistoryEntry {
  from: string;
  to: string;
  renamedAt: string;
}

interface ModelCapacityBlock {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
  blockSetAt: string;
  sourcePhase: RuntimeErrorEvent["phase"];
  reason: string;
}

function getCortexWorkerPromptsBackupSuffix(content: string): ".v1.bak" | ".v2.bak" | ".v3.bak" | undefined {
  if (content.includes(CORTEX_WORKER_PROMPTS_VERSION_MARKER)) {
    return undefined;
  }

  for (const marker of PREVIOUS_CORTEX_WORKER_PROMPTS_VERSION_MARKERS) {
    if (content.includes(marker)) {
      return marker.includes("Version: 3") ? ".v3.bak" : ".v2.bak";
    }
  }

  if (LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES.every((signature) => content.includes(signature))) {
    return ".v1.bak";
  }

  return undefined;
}

function shouldUpgradeLegacyCortexWorkerPrompts(content: string): boolean {
  return getCortexWorkerPromptsBackupSuffix(content) !== undefined;
}

async function backupLegacyCortexWorkerPrompts(path: string, content: string): Promise<void> {
  const suffix = getCortexWorkerPromptsBackupSuffix(content);
  if (!suffix) {
    return;
  }

  try {
    await copyFile(path, `${path}${suffix}`);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST"
    ) {
      return;
    }

    throw error;
  }
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();
  private readonly runtimeController: SwarmRuntimeController;
  private readonly runtimes: Map<string, SwarmAgentRuntime>;
  private readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  private readonly runtimeTokensByAgentId: Map<string, number>;
  private readonly pendingManagerRuntimeRecycleAgentIds = new Set<string>();
  private readonly pendingManagerRuntimeRecycleReasonsByAgentId = new Map<string, ManagerRuntimeRecycleReason>();
  private readonly projectAgentMessageTimestampsBySender = new Map<string, number[]>();
  private readonly pendingManualManagerStopNoticeTimersByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly pinnedMessageIdsBySessionAgentId = new Map<string, Set<string>>();
  private readonly workerHealthService: SwarmWorkerHealthService;
  private readonly specialistFallbackManager: SwarmSpecialistFallbackManager;
  private readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  private readonly sidebarPerfRecorder: SidebarPerfRecorder;
  private readonly conversationProjector: ConversationProjector;
  private readonly persistenceService: PersistenceService;
  private readonly forgeExtensionHost: ForgeExtensionHost;
  private piModelsJsonPath: string | null = null;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly skillFileService: SkillFileService;
  private readonly secretsEnvService: SecretsEnvService;
  private readonly sessionMetaService: SwarmSessionMetaService;
  private readonly cortexService: SwarmCortexService;
  private readonly memoryMergeService: SwarmMemoryMergeService;
  private readonly sessionProvisioner: SessionProvisioner;
  private readonly lifecycleService: SwarmAgentLifecycleService;
  private readonly settingsService: SwarmSettingsService;
  private readonly choiceService: SwarmChoiceService;
  private readonly promptService: SwarmPromptService;
  private readonly sessionService: SwarmSessionService;
  private readonly projectAgentService: SwarmProjectAgentService;
  readonly promptRegistry: PromptRegistry;

  private integrationContextProvider: ((profileId: string) => string) | undefined;
  private readonly versioningService: VersioningMutationSink | undefined;
  private specialistRegistryModulePromise: Promise<SpecialistRegistryModule> | null = null;

  constructor(config: SwarmConfig, options?: { now?: () => string; versioningService?: VersioningMutationSink }) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
    this.versioningService = options?.versioningService;
    const resourcesDir = this.config.paths.resourcesDir ?? this.config.paths.rootDir;
    this.promptRegistry = new FileBackedPromptRegistry({
      dataDir: this.config.paths.dataDir,
      repoDir: this.config.paths.rootDir,
      builtinArchetypesDir: join(resourcesDir, "apps", "backend", "src", "swarm", "archetypes", "builtins"),
      builtinOperationalDir: join(resourcesDir, "apps", "backend", "src", "swarm", "operational", "builtins"),
      versioning: this.versioningService
    });
    this.forgeExtensionHost = new ForgeExtensionHost({
      dataDir: this.config.paths.dataDir,
      now: this.now
    });
    this.sidebarPerfRecorder = createSidebarPerfRegistry({
      manifest: backendSidebarPerfMetricManifest
    });
    this.runtimeController = new SwarmRuntimeController(this as unknown as SwarmRuntimeControllerHost);
    this.runtimes = this.runtimeController.runtimes;
    this.runtimeCreationPromisesByAgentId = this.runtimeController.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = this.runtimeController.runtimeTokensByAgentId;
    this.workerHealthService = new SwarmWorkerHealthService({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      now: this.now,
      getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, sendOptions) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, sendOptions),
      publishToUser: (agentId, text, source) => this.publishToUser(agentId, text, source),
      terminateDescriptor: (descriptor, terminateOptions) => this.terminateDescriptor(descriptor, terminateOptions),
      saveStore: () => this.saveStore(),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.resolvePromptWithFallback(category, promptId, profileId, fallback),
      isRuntimeInContextRecovery: (agentId) => this.isRuntimeInContextRecovery(agentId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.specialistFallbackManager = new SwarmSpecialistFallbackManager({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      runtimeCreationPromisesByAgentId: this.runtimeCreationPromisesByAgentId,
      runtimeTokensByAgentId: this.runtimeTokensByAgentId,
      workerHealthService: this.workerHealthService,
      now: this.now,
      resolveSpecialistRosterForProfile: (profileId) => this.resolveSpecialistRosterForProfile(profileId),
      resolveSpawnModelWithCapacityFallback: (model) => this.resolveSpawnModelWithCapacityFallback(model),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor),
      injectWorkerIdentityContext: (descriptor, systemPrompt) =>
        this.injectWorkerIdentityContext(descriptor, systemPrompt),
      createRuntimeForDescriptor: (descriptor, systemPrompt, runtimeToken, options) =>
        this.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options),
      attachRuntime: (agentId, runtime) => {
        this.runtimeController.attachRuntime(agentId, runtime);
      },
      detachRuntime: (agentId, runtimeToken) => this.runtimeController.detachRuntime(agentId, runtimeToken),
      updateSessionMetaForWorkerDescriptor: (descriptor, resolvedSystemPrompt) =>
        this.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt ?? undefined),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      saveStore: () => this.saveStore(),
      emitStatus: (agentId, status, pendingCount, contextUsage) =>
        this.emitStatus(agentId, status, pendingCount, contextUsage),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      clearTrackedToolPaths: (agentId) => {
        this.runtimeController.clearTrackedToolPaths(agentId);
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.runtimeController.setSpecialistFallbackManager(this.specialistFallbackManager);
    this.persistenceService = new PersistenceService({
      config: this.config,
      descriptors: this.descriptors,
      sortedDescriptors: () => this.sortedDescriptors(),
      sortedProfiles: () => this.sortedProfiles(),
      getConfiguredManagerId: () => this.getConfiguredManagerId(),
      resolveMemoryOwnerAgentId: (descriptor) => this.resolveMemoryOwnerAgentId(descriptor),
      validateAgentDescriptor,
      extractDescriptorAgentId,
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.conversationProjector = new ConversationProjector({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      conversationEntriesByAgentId: this.conversationEntriesByAgentId,
      now: this.now,
      emitServerEvent: (eventName, payload) => {
        this.emit(eventName, payload);
      },
      logDebug: (message, details) => this.logDebug(message, details),
      perf: this.sidebarPerfRecorder,
      getPinnedMessageIds: (agentId) => this.pinnedMessageIdsBySessionAgentId.get(agentId)
    });
    this.skillMetadataService = new SkillMetadataService({
      config: this.config
    });
    this.skillFileService = new SkillFileService();
    this.secretsEnvService = new SecretsEnvService({
      config: this.config,
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getSkillMetadata: () => this.skillMetadataService.getSkillMetadata()
    });
    this.sessionMetaService = new SwarmSessionMetaService({
      dataDir: this.config.paths.dataDir,
      agentsStoreFile: this.config.paths.agentsStoreFile,
      descriptors: this.descriptors,
      getSortedDescriptors: () => this.sortedDescriptors(),
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getAdditionalSkillPaths: () => this.skillMetadataService.getAdditionalSkillPaths(),
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor)
    });
    this.cortexService = new SwarmCortexService({
      config: this.config,
      now: this.now,
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      getWorkersForManager: (managerId) => this.getWorkersForManager(managerId),
      getConversationHistory: (agentId) => this.getConversationHistory(agentId),
      createSession: (profileId, options) => this.createSession(profileId, options),
      handleUserMessage: (text, options) => this.handleUserMessage(text, options),
      ensureCortexProfile: () => this.ensureCortexProfile(),
      sendMessage: (fromAgentId, targetAgentId, message, delivery, options) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, options),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.memoryMergeService = new SwarmMemoryMergeService({
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      upsertDescriptor: (descriptor) => {
        this.descriptors.set(descriptor.agentId, descriptor);
      },
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      resolvePreferredManagerId: (options) => this.resolvePreferredManagerId(options),
      resolvePromptWithFallback: (category, promptId, profileId, fallback) =>
        this.resolvePromptWithFallback(category, promptId, profileId, fallback),
      ensureMemoryFilesForBoot: (options) => this.persistenceService.ensureMemoryFilesForBoot(options),
      ensureAgentMemoryFileInPersistence: (memoryFilePath, memoryTemplateContent) =>
        this.persistenceService.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent),
      readSessionMetaForDescriptor: (descriptor) => this.readSessionMetaForDescriptor(descriptor),
      writeSessionMemoryMergeAttemptMeta: (descriptor, attempt) =>
        this.writeSessionMemoryMergeAttemptMeta(descriptor, attempt),
      recordSessionMemoryMergeAttempt: (descriptor, attempt) =>
        this.recordSessionMemoryMergeAttempt(descriptor, attempt),
      appendSessionMemoryMergeAuditEntry: (entry) => this.appendSessionMemoryMergeAuditEntry(entry),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      queueVersioningMutation: (mutation) => {
        this.queueVersioningMutation(mutation);
      },
      resolveActiveCortexReviewRunIdForDescriptor: (descriptor) =>
        this.cortexService.resolveActiveReviewRunIdForDescriptor(descriptor),
      saveStore: async () => {
        await this.saveStore();
      },
      runSessionMemoryLLMMerge: (descriptor, profileMemoryContent, sessionMemoryContent) =>
        this.executeSessionMemoryLLMMerge(descriptor, profileMemoryContent, sessionMemoryContent),
      getPiModelsJsonPath: () => this.getPiModelsJsonPathOrThrow()
    });
    this.sessionProvisioner = new SessionProvisioner({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      runtimes: this.runtimes,
      pinnedMessageIdsBySessionAgentId: this.pinnedMessageIdsBySessionAgentId,
      conversationProjector: this.conversationProjector,
      ensureProfilePiDirectories: (profileId) => this.ensureProfilePiDirectories(profileId),
      ensureSessionFileParentDirectory: (sessionFile) => this.ensureSessionFileParentDirectory(sessionFile),
      ensureAgentMemoryFile: (memoryFilePath, profileId) => this.ensureAgentMemoryFile(memoryFilePath, profileId),
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      writeInitialSessionMeta: (descriptor) => this.writeInitialSessionMeta(descriptor),
      runRuntimeShutdown: (descriptor, action, options) => this.runRuntimeShutdown(descriptor, action, options),
      detachRuntime: (agentId, runtimeToken) => this.detachRuntime(agentId, runtimeToken),
      deleteManagerSessionFile: (sessionFile) => this.deleteManagerSessionFile(sessionFile),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.settingsService = new SwarmSettingsService({
      config: this.config,
      profiles: this.profiles,
      skillMetadataService: this.skillMetadataService,
      skillFileService: this.skillFileService,
      secretsEnvService: this.secretsEnvService,
      getSessionsForProfile: (profileId) => this.getSessionsForProfile(profileId) as Array<AgentDescriptor & { role: "manager"; profileId: string }>,
      resolveAndValidateCwd: (cwd) => this.resolveAndValidateCwd(cwd),
      assertCanChangeManagerCwd: (profileId, sessions) => this.assertCanChangeManagerCwd(profileId, sessions),
      applyManagerRuntimeRecyclePolicy: (agentId, reason) => this.applyManagerRuntimeRecyclePolicy(agentId, reason),
      now: this.now,
      saveStore: async () => {
        await this.saveStore();
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.choiceService = new SwarmChoiceService({
      now: this.now,
      getDescriptor: (agentId) => this.descriptors.get(agentId),
      emitChoiceRequest: (event) => {
        this.emitChoiceRequest(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      }
    });
    this.promptService = new SwarmPromptService({
      config: this.config,
      descriptors: this.descriptors,
      profiles: this.profiles,
      promptRegistry: this.promptRegistry,
      skillMetadataService: this.skillMetadataService,
      getAgentMemoryPath: (agentId) => this.getAgentMemoryPath(agentId),
      ensureAgentMemoryFile: (memoryFilePath, profileId) =>
        this.ensureAgentMemoryFile(memoryFilePath, profileId),
      resolveMemoryOwnerAgentId: (descriptor) => this.resolveMemoryOwnerAgentId(descriptor),
      resolveSessionProfileId: (memoryOwnerAgentId) => this.resolveSessionProfileId(memoryOwnerAgentId),
      refreshSessionMetaStats: (descriptor) => this.refreshSessionMetaStats(descriptor),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) =>
        this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      getSessionsForProfile: (profileId) => this.getSessionsForProfile(profileId),
      loadSpecialistRegistryModule: () => this.loadSpecialistRegistryModule(),
      getIntegrationContext: (profileId) => this.integrationContextProvider?.(profileId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.lifecycleService = new SwarmAgentLifecycleService({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      profiles: this.profiles,
      runtimes: this.runtimes,
      runtimeCreationPromisesByAgentId: this.runtimeCreationPromisesByAgentId,
      pendingManagerRuntimeRecycleAgentIds: this.pendingManagerRuntimeRecycleAgentIds,
      pendingManagerRuntimeRecycleReasonsByAgentId: this.pendingManagerRuntimeRecycleReasonsByAgentId,
      modelCapacityBlocks: this.modelCapacityBlocks,
      sessionProvisioner: this.sessionProvisioner,
      now: this.now,
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      assertManager: (agentId, action) => this.assertManager(agentId, action),
      hasRunningManagers: (options) => this.hasRunningManagers(options),
      generateUniqueAgentId: (source) => this.generateUniqueAgentId(source),
      generateUniqueManagerId: (source) => this.generateUniqueManagerId(source),
      resolveAndValidateCwd: (cwd) => this.resolveAndValidateCwd(cwd),
      resolveDefaultModelDescriptor: () => this.resolveDefaultModelDescriptor(),
      resolveSpawnWorkerArchetypeId: (input, normalizedAgentId, profileId) =>
        this.resolveSpawnWorkerArchetypeId(input, normalizedAgentId, profileId),
      resolveSpecialistRosterForProfile: (profileId) => this.resolveSpecialistRosterForProfile(profileId),
      normalizeSpecialistHandle: async (value) => {
        const specialistModule = await this.loadSpecialistRegistryModule();
        return specialistModule.normalizeSpecialistHandle(value) || undefined;
      },
      resolveSystemPromptForDescriptor: (descriptor) => this.resolveSystemPromptForDescriptor(descriptor),
      injectWorkerIdentityContext: (descriptor, systemPrompt) =>
        this.injectWorkerIdentityContext(descriptor, systemPrompt),
      createRuntimeForDescriptor: (descriptor, systemPrompt, runtimeToken, options) =>
        this.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options),
      allocateRuntimeToken: (agentId) => this.allocateRuntimeToken(agentId),
      clearRuntimeToken: (agentId, runtimeToken) => this.clearRuntimeToken(agentId, runtimeToken),
      getRuntimeToken: (agentId) => this.runtimeTokensByAgentId.get(agentId),
      ensureSessionFileParentDirectory: (sessionFile) => this.ensureSessionFileParentDirectory(sessionFile),
      updateSessionMetaForWorkerDescriptor: (descriptor, resolvedSystemPrompt) =>
        this.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt),
      refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.refreshSessionMetaStatsBySessionId(sessionAgentId),
      refreshSessionMetaStats: (descriptor) => this.refreshSessionMetaStats(descriptor),
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      prepareManagerRuntimeCreation: (descriptor, systemPrompt) =>
        this.prepareManagerRuntimeCreation(descriptor, systemPrompt),
      appendAppliedModelChangeContinuity: (descriptor, request, runtime) =>
        this.appendAppliedModelChangeContinuity(descriptor, request, runtime),
      attachRuntime: (agentId, runtime) => {
        this.runtimeController.attachRuntime(agentId, runtime);
      },
      saveStore: async () => {
        await this.saveStore();
      },
      emitStatus: (agentId, status, pendingCount, contextUsage) =>
        this.emitStatus(agentId, status, pendingCount, contextUsage),
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      logDebug: (message, details) => this.logDebug(message, details),
      seedWorkerCompletionReportTimestamp: (agentId) => this.seedWorkerCompletionReportTimestamp(agentId),
      clearWatchdogState: (agentId) => {
        this.clearWatchdogState(agentId);
      },
      deleteWorkerStallState: (agentId) => {
        this.workerHealthService.deleteWorkerStallState(agentId);
      },
      deleteWorkerActivityState: (agentId) => {
        this.workerHealthService.deleteWorkerActivityState(agentId);
      },
      deleteWorkerCompletionReportState: (agentId) => {
        this.workerHealthService.deleteWorkerCompletionReportState(agentId);
      },
      clearTrackedToolPaths: (agentId) => {
        this.runtimeController.clearTrackedToolPaths(agentId);
      },
      suppressIntentionalStopRuntimeCallbacks: (agentId, runtimeToken) => {
        this.runtimeController.suppressIntentionalStopRuntimeCallbacks(agentId, runtimeToken);
      },
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, runtimeToken) => {
        this.runtimeController.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);
      },
      markPendingManualManagerStopNotice: (agentId) => this.markPendingManualManagerStopNotice(agentId),
      cancelAllPendingChoicesForAgent: (agentId) => {
        this.cancelAllPendingChoicesForAgent(agentId);
      },
      runRuntimeShutdown: (descriptor, action, options) => this.runRuntimeShutdown(descriptor, action, options),
      detachRuntime: (agentId, runtimeToken) => this.detachRuntime(agentId, runtimeToken),
      syncPinnedContentForManagerRuntime: async (descriptor, options) => {
        await this.syncPinnedContentForManagerRuntime(descriptor, options);
      },
      sendMessage: (fromAgentId, targetAgentId, message, delivery, options) =>
        this.sendMessage(fromAgentId, targetAgentId, message, delivery, options),
      sendManagerBootstrapMessage: (managerId) => this.sendManagerBootstrapMessage(managerId),
      materializeSortOrder: () => {
        this.materializeSortOrder();
      },
      getSessionsForProfile: (profileId) =>
        this.getSessionsForProfile(profileId) as Array<AgentDescriptor & { role: "manager"; profileId: string }>,
      getWorkersForManager: (managerId) => this.getWorkersForManager(managerId),
      deleteConversationHistory: (agentId, sessionFile) => {
        this.conversationProjector.deleteConversationHistory(agentId, sessionFile);
      },
      deleteManagerSchedulesFile: (profileId) => this.deleteManagerSchedulesFile(profileId),
      migrateLegacyProfileKnowledgeToReferenceDoc: async (profileId) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profileId, {
          versioning: this.versioningService
        });
      }
    });
    this.sessionService = new SwarmSessionService({
      profiles: this.profiles,
      runtimes: this.runtimes,
      provisioner: this.sessionProvisioner,
      prepareSessionCreation: (profileId, options) => this.prepareSessionCreation(profileId, options),
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      stopSessionInternal: (agentId, options) => this.stopSessionInternal(agentId, options),
      assertSessionIsDeletable: (descriptor) => this.assertSessionIsDeletable(descriptor),
      saveStore: async () => {
        await this.saveStore();
      },
      writeInitialSessionMeta: (descriptor) => this.writeInitialSessionMeta(descriptor),
      deleteProjectAgentRecord: (profileId, handle) =>
        deleteProjectAgentRecord(this.config.paths.dataDir, profileId, handle),
      notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
      emitSessionLifecycle: (event) => {
        this.emitSessionLifecycle(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      emitConversationReset: (agentId, source) => {
        this.emitConversationReset(agentId, source as "api_reset");
      },
      injectAgentCreatorContext: (agentId, profileId) => this.injectAgentCreatorContext(agentId, profileId),
      cancelAllPendingChoicesForAgent: (agentId) => {
        this.cancelAllPendingChoicesForAgent(agentId);
      },
      getSessionDirForDescriptor: (descriptor) => this.getSessionDirForDescriptor(descriptor),
      syncPinnedContentForManagerRuntime: async (descriptor, options) => {
        await this.syncPinnedContentForManagerRuntime(descriptor, options);
      },
      resetConversationHistory: (agentId) => {
        this.conversationProjector.resetConversationHistory(agentId);
      },
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      appendSessionRenameHistoryEntry: (descriptor, entry) => this.appendSessionRenameHistoryEntry(descriptor, entry),
      copySessionHistoryForFork: (sourceSessionFile, targetSessionFile, fromMessageId) =>
        this.copySessionHistoryForFork(sourceSessionFile, targetSessionFile, fromMessageId),
      copyPinnedMessagesForFork: (sourceDescriptor, forkedDescriptor) =>
        this.copyPinnedMessagesForFork(sourceDescriptor, forkedDescriptor),
      writeForkedSessionMemoryHeader: (sourceDescriptor, forkedSessionAgentId, fromMessageId) =>
        this.writeForkedSessionMemoryHeader(sourceDescriptor, forkedSessionAgentId, fromMessageId),
      logDebug: (message, details) => this.logDebug(message, details),
      now: this.now
    });
    this.projectAgentService = new SwarmProjectAgentService({
      dataDir: this.config.paths.dataDir,
      descriptors: this.descriptors,
      provisioner: this.sessionProvisioner,
      now: this.now,
      prepareSessionCreation: (profileId, options) => this.prepareSessionCreation(profileId, options),
      getRequiredSessionDescriptor: (agentId) => this.getRequiredSessionDescriptor(agentId),
      assertSessionSupportsProjectAgent: (descriptor) => this.assertSessionSupportsProjectAgent(descriptor),
      buildProjectAgentInfoForSession: (descriptor, whenToUse, systemPrompt, handle, capabilities) =>
        this.buildProjectAgentInfoForSession(descriptor, whenToUse, systemPrompt, handle, capabilities),
      getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
      captureSessionRuntimePromptMeta: (descriptor, resolvedSystemPrompt) =>
        this.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt),
      saveStore: async () => {
        await this.saveStore();
      },
      emitSessionLifecycle: (event) => {
        this.emitSessionLifecycle(event);
      },
      emitAgentsSnapshot: () => {
        this.emitAgentsSnapshot();
      },
      emitProfilesSnapshot: () => {
        this.emitProfilesSnapshot();
      },
      emitSessionProjectAgentUpdated: (agentId, profileId, projectAgent) => {
        this.emitSessionProjectAgentUpdated(agentId, profileId, projectAgent);
      },
      notifyProjectAgentsChanged: (profileId) => this.notifyProjectAgentsChanged(profileId),
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.sharedAuthFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();
    await migrateSharedConfigLayout(this.config.paths.dataDir);
    await cleanupOldSharedConfigPaths(this.config.paths.dataDir);
    await ensureCanonicalAuthFilePath(this.config);
    await this.reloadModelCatalogOverridesAndProjection();
    await this.loadSecretsStore();
    await this.reloadSkillMetadata();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }

    await this.refreshDefaultMemoryTemplateNormalizedLines();

    let loaded = await this.loadStore();
    const migrationResult = await migrateDataDirectory(
      {
        dataDir: this.config.paths.dataDir,
        agentsStoreFile: this.config.paths.agentsStoreFile
      },
      loaded.agents,
      loaded.profiles ?? [],
      {
        debug: (message, details) => this.logDebug(message, details),
        info: (message, details) => this.logDebug(message, details),
        warn: (message, details) => this.logDebug(message, details)
      }
    );
    loaded = {
      ...loaded,
      agents: migrationResult.updatedAgents
    };
    const cortexPruneResult = this.prunePersistedCortexStateForBoot(loaded);
    loaded = cortexPruneResult.store;

    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }
    for (const profile of loaded.profiles ?? []) {
      this.profiles.set(profile.profileId, profile);
    }

    await this.preloadPinnedMessageIndexes();

    this.reconcileProfilesOnBoot();
    if (cortexPruneResult.pruned) {
      await this.saveStore();
    }
    await this.ensureCortexProfile();
    await loadOnboardingState(this.config.paths.dataDir);
    await this.ensureLegacyProfileKnowledgeReferenceDocs();
    // IMPORTANT: reconcileInterruptedCortexReviewRunsForBoot MUST precede
    // normalizeStreamingStatusesForBoot — reconciliation relies on descriptors
    // still having status "streaming" to detect interrupted review runs.
    // Reordering these calls will silently break interrupted-run detection.
    await this.cortexService.reconcileInterruptedReviewRunsForBoot();
    this.normalizeStreamingStatusesForBoot();
    await this.recoverMissingWorkerDescriptorsForBoot();

    // Reconcile project agent storage: hydrate descriptors from on-disk config,
    // materialize missing directories from descriptor data (first-boot migration).
    for (const profile of this.profiles.values()) {
      const result = await reconcileProjectAgentStorage(
        this.config.paths.dataDir,
        profile.profileId,
        this.descriptors
      );
      if (result.materialized.length > 0) {
        console.info(
          `[swarm][boot] Materialized ${result.materialized.length} project agent(s) for profile ${profile.profileId}: ${result.materialized.join(", ")}`
        );
      }
      if (result.hydrated.length > 0) {
        console.info(
          `[swarm][boot] Hydrated ${result.hydrated.length} project agent descriptor(s) for profile ${profile.profileId}: ${result.hydrated.join(", ")}`
        );
      }
      if (result.orphansRemoved.length > 0) {
        console.info(
          `[swarm][boot] Removed ${result.orphansRemoved.length} orphan project agent director(ies) for profile ${profile.profileId}: ${result.orphansRemoved.join(", ")}`
        );
      }
    }

    await this.ensureMemoryFilesForBoot();
    await this.saveStore();
    await this.rebuildSessionManifestForBoot();
    await this.hydrateCompactionCountsForBoot();
    this.startCompactionCountBackfill();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    const loadedPrompts = await this.promptRegistry.listAll();
    const loadedArchetypeIds = loadedPrompts
      .filter((entry) => entry.category === "archetype")
      .map((entry) => entry.promptId)
      .sort((left, right) => left.localeCompare(right));

    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();
    this.cortexService.scheduleReviewRunQueueCheck(0);

    this.workerHealthService.ensureStarted();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds,
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    this.runtimeController.updateWorkerActivity(agentId, event);
  }

  async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor,
  ): Promise<AgentModelDescriptor | undefined> {
    return this.specialistFallbackManager.resolveSpecialistFallbackModelForDescriptor(descriptor);
  }

  async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    return this.specialistFallbackManager.maybeRecoverWorkerWithSpecialistFallback({
      agentId,
      errorMessage,
      sourcePhase,
      runtimeToken,
      handleRuntimeStatus: (token, targetAgentId, status, pendingCount, contextUsage) =>
        this.handleRuntimeStatus(token, targetAgentId, status, pendingCount, contextUsage),
      handleRuntimeAgentEnd: (token, targetAgentId) => this.handleRuntimeAgentEnd(token, targetAgentId)
    });
  }

  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined {
    return this.workerHealthService.getWorkerActivity(agentId);
  }

  listBootstrapAgents(): AgentDescriptor[] {
    return this.listManagerAgents();
  }

  listManagerAgents(): AgentDescriptor[] {
    return this.buildManagerSnapshotDescriptors({ includeStreamingWorkers: false });
  }

  listWorkersForSession(sessionAgentId: string): AgentDescriptor[] {
    return this.sortedDescriptors()
      .filter((descriptor) => descriptor.role === "worker" && descriptor.managerId === sessionAgentId)
      .map((descriptor) => cloneDescriptor(descriptor));
  }

  listProfiles(): ManagerProfile[] {
    return this.sortedProfiles().map((profile) => ({ ...profile }));
  }

  async listCortexReviewRuns(): Promise<CortexReviewRunRecord[]> {
    return this.cortexService.listReviewRuns();
  }

  async startCortexReviewRun(input: {
    scope: CortexReviewRunScope;
    trigger: CortexReviewRunTrigger;
    sourceContext?: MessageSourceContext;
    requestText?: string;
    scheduleName?: string | null;
  }): Promise<CortexReviewRunRecord | null> {
    return this.cortexService.startReviewRun(input);
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId);
  }

  getConversationHistoryWithDiagnostics(agentId?: string): {
    history: ConversationEntryEvent[];
    diagnostics: SidebarConversationHistoryDiagnostics;
  } {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return {
        history: [],
        diagnostics: {
          cacheState: "memory",
          historySource: "memory",
          coldLoad: false,
          fsReadOps: 0,
          fsReadBytes: 0,
          detail: "missing_agent"
        }
      };
    }

    return this.conversationProjector.getConversationHistoryWithDiagnostics(resolvedAgentId);
  }

  getSidebarPerfRecorder(): SidebarPerfRecorder {
    return this.sidebarPerfRecorder;
  }

  readSidebarPerfSummary(): SidebarPerfSummary {
    return this.sidebarPerfRecorder.readSummary();
  }

  readSidebarPerfSlowEvents(): SidebarPerfSlowEvent[] {
    return this.sidebarPerfRecorder.readRecentSlowEvents();
  }

  private async preloadPinnedMessageIndexes(): Promise<void> {
    const sessionDescriptors = Array.from(this.descriptors.values()).filter((descriptor) => this.isSessionAgent(descriptor));

    await Promise.all(
      sessionDescriptors.map(async (descriptor) => {
        const registry = await loadPins(this.getSessionDirForDescriptor(descriptor));
        this.setPinnedRegistryForAgent(descriptor.agentId, registry);
      })
    );
  }

  private setPinnedRegistryForAgent(agentId: string, registry: PinRegistry): void {
    const pinnedMessageIds = Object.keys(registry.pins);
    if (pinnedMessageIds.length === 0) {
      this.pinnedMessageIdsBySessionAgentId.delete(agentId);
      return;
    }

    this.pinnedMessageIdsBySessionAgentId.set(agentId, new Set(pinnedMessageIds));
  }

  private async syncPinnedContentForManagerRuntime(
    descriptor: AgentDescriptor & { role: "manager" },
    options?: {
      registry?: PinRegistry;
      runtime?: SwarmAgentRuntime;
      setPinnedContentOptions?: SetPinnedContentOptions;
    }
  ): Promise<PinRegistry> {
    const registry = options?.registry ?? await loadPins(this.getSessionDirForDescriptor(descriptor));
    this.setPinnedRegistryForAgent(descriptor.agentId, registry);

    const runtime = options?.runtime ?? this.runtimes.get(descriptor.agentId);
    if (runtime?.setPinnedContent) {
      await runtime.setPinnedContent(
        formatPinnedMessagesForCompaction(registry),
        options?.setPinnedContentOptions
      );
    }

    return registry;
  }

  private getSessionDirForDescriptor(descriptor: { agentId: string; profileId?: string }): string {
    return getSessionDir(
      this.config.paths.dataDir,
      descriptor.profileId ?? descriptor.agentId,
      descriptor.agentId
    );
  }

  async requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]> {
    return this.choiceService.requestUserChoice(agentId, questions);
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    this.choiceService.resolveChoiceRequest(choiceId, answers);
  }

  cancelChoiceRequest(choiceId: string, reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">): void {
    this.choiceService.cancelChoiceRequest(choiceId, reason);
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    this.choiceService.cancelAllPendingChoicesForAgent(agentId);
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    return this.choiceService.hasPendingChoicesForSession(sessionAgentId);
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    return this.choiceService.getPendingChoiceIdsForSession(sessionAgentId);
  }

  getPendingChoiceOwner(choiceId: string): { agentId: string; sessionAgentId: string } | undefined {
    return this.choiceService.getPendingChoiceOwner(choiceId);
  }

  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined {
    return this.choiceService.getPendingChoice(choiceId);
  }

  async createSession(
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const createdSession = await this.sessionService.createSession(profileId, options);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdSession.sessionAgent
    });
    return createdSession;
  }

  async createSessionFromAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      cwd?: string;
      model?: unknown;
      reasoningLevel?: unknown;
      systemPrompt?: string;
      initialMessage?: string;
    }
  ): Promise<{ sessionAgentId: string; sessionLabel: string; profileId: string }> {
    const creatorDescriptor = this.getRequiredSessionDescriptor(creatorAgentId);

    if (creatorDescriptor.role !== "manager") {
      throw new Error(`Only manager sessions can create child sessions: ${creatorAgentId}`);
    }

    if (!creatorDescriptor.projectAgent?.capabilities?.includes("create_session")) {
      throw new Error("Session creation is not allowed for this project agent");
    }

    const profileId = creatorDescriptor.profileId ?? creatorDescriptor.agentId;
    const normalizedSessionName = params.sessionName.trim();
    if (!normalizedSessionName) {
      throw new Error("sessionName must be a non-empty string");
    }

    const preset = parseSwarmModelPreset(params.model, "create_session.model");
    const resolvedModel = preset
      ? resolveModelDescriptorFromPreset(preset)
      : { ...creatorDescriptor.model };

    const parsedReasoningLevel = parseSwarmReasoningLevel(params.reasoningLevel, "create_session.reasoningLevel");
    if (parsedReasoningLevel) {
      resolvedModel.thinkingLevel = parsedReasoningLevel;
    }

    const normalizedModel = {
      ...resolvedModel,
      provider: normalizeOptionalAgentId(resolvedModel.provider)?.toLowerCase() ?? resolvedModel.provider,
      modelId: normalizeOptionalModelId(resolvedModel.modelId)?.toLowerCase() ?? resolvedModel.modelId,
      thinkingLevel: normalizeThinkingLevelForProvider(
        resolvedModel.provider,
        resolvedModel.thinkingLevel
      )
    };

    const normalizedSystemPrompt = params.systemPrompt?.trim();
    const normalizedCwd = params.cwd?.trim();
    const createdSession = await this.sessionService.createSessionWithOverrides(
      profileId,
      {
        name: normalizedSessionName,
        label: normalizedSessionName,
        sessionPurpose: undefined,
      },
      {
        model: {
          ...normalizedModel,
          provider: normalizeOptionalAgentId(normalizedModel.provider)?.toLowerCase() ?? normalizedModel.provider,
          modelId: normalizeOptionalModelId(normalizedModel.modelId)?.toLowerCase() ?? normalizedModel.modelId,
          thinkingLevel: normalizeThinkingLevelForProvider(
            normalizedModel.provider,
            normalizedModel.thinkingLevel
          )
        },
        ...(normalizedCwd ? { cwd: await this.resolveAndValidateCwd(normalizedCwd) } : {}),
        ...(normalizedSystemPrompt !== undefined ? { sessionSystemPrompt: normalizedSystemPrompt } : {})
      }
    );

    const targetAgentId = createdSession.sessionAgent.agentId;
    createdSession.sessionAgent.creatorAgentId = creatorDescriptor.agentId;

    const targetDescriptor = this.getRequiredSessionDescriptor(targetAgentId);
    targetDescriptor.creatorAgentId = creatorDescriptor.agentId;
    await this.saveStore();
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    if (params.initialMessage?.trim()) {
      try {
        await this.sendMessage(creatorAgentId, targetAgentId, params.initialMessage.trim(), "auto");
      } catch (error) {
        // Roll back the half-created session so a failed initial-message delivery
        // does not leak a session the caller cannot reach.
        try {
          await this.sessionService.deleteSession(targetAgentId);
        } catch (rollbackError) {
          this.logDebug("createSessionFromAgent rollback failed", {
            creatorAgentId,
            targetAgentId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          });
        }
        throw error;
      }
    }

    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: cloneDescriptor(targetDescriptor)
    });

    return {
      sessionAgentId: targetAgentId,
      sessionLabel: targetDescriptor.sessionLabel ?? targetDescriptor.displayName,
      profileId
    };
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
      capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
    }
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    const createdProjectAgent = await this.projectAgentService.createAndPromoteProjectAgent(creatorAgentId, params);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: cloneDescriptor(this.getRequiredSessionDescriptor(createdProjectAgent.agentId))
    });
    return createdProjectAgent;
  }

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    return this.lifecycleService.stopSession(agentId);
  }

  async resumeSession(agentId: string): Promise<void> {
    await this.lifecycleService.resumeSession(agentId);
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const deletedSessionDescriptor = cloneDescriptor(this.getRequiredSessionDescriptor(agentId));
    const result = await this.sessionService.deleteSession(agentId);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "deleted",
      sessionDescriptor: deletedSessionDescriptor
    });
    return result;
  }

  async pinMessage(
    agentId: string,
    messageId: string,
    pinned: boolean
  ): Promise<{ pinned: boolean; timestamp: string }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const sessionDir = this.getSessionDirForDescriptor(descriptor);
    const history = this.getConversationHistory(agentId);
    const message = history.find(
      (entry): entry is ConversationMessageEvent & { role: "user" | "assistant" } => (
        entry.type === "conversation_message" &&
        entry.id === messageId &&
        (entry.role === "user" || entry.role === "assistant")
      )
    );

    if (pinned && !message) {
      throw new Error(`Message not found or not pinnable: ${messageId}`);
    }

    const registry = await togglePin(
      sessionDir,
      messageId,
      pinned,
      message
        ? {
            role: message.role,
            text: message.text,
            timestamp: message.timestamp,
            attachments: message.attachments
          }
        : undefined
    );

    await this.syncPinnedContentForManagerRuntime(descriptor, { registry });
    this.conversationProjector.setConversationMessagePinned(agentId, messageId, pinned);

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await this.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    const timestamp = this.now();
    this.logDebug("message:pin", {
      agentId,
      messageId,
      pinned
    });

    return {
      pinned,
      timestamp
    };
  }

  async clearAllPins(agentId: string): Promise<void> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const sessionDir = this.getSessionDirForDescriptor(descriptor);
    const previouslyPinnedMessageIds = await clearAllSessionPins(sessionDir);

    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await this.syncPinnedContentForManagerRuntime(descriptor, { registry: emptyRegistry });

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await this.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    if (previouslyPinnedMessageIds.length === 0) {
      return;
    }

    for (const messageId of previouslyPinnedMessageIds) {
      this.conversationProjector.setConversationMessagePinned(agentId, messageId, false);
      this.emitMessagePinned(agentId, messageId, false, this.now());
    }

    this.logDebug("message:clear_all_pins", {
      agentId,
      clearedCount: previouslyPinnedMessageIds.length
    });
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    await this.sessionService.clearSessionConversation(agentId);
  }

  async pinSession(agentId: string, pinned: boolean): Promise<{ pinnedAt: string | null }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);

    if (pinned) {
      descriptor.pinnedAt = descriptor.pinnedAt ?? this.now();
    } else {
      delete descriptor.pinnedAt;
    }

    this.descriptors.set(agentId, descriptor);
    await this.saveStore();
    this.emitAgentsSnapshot();

    return {
      pinnedAt: descriptor.pinnedAt ?? null
    };
  }

  async setSessionProjectAgent(
    agentId: string,
    projectAgent:
      | {
          whenToUse: string;
          systemPrompt?: string;
          handle?: string;
          capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"];
        }
      | null
  ): Promise<{ profileId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null }> {
    return this.projectAgentService.setSessionProjectAgent(agentId, projectAgent);
  }

  async requestProjectAgentRecommendations(agentId: string): Promise<ProjectAgentRecommendations> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    this.assertSessionSupportsProjectAgent(descriptor);

    const [conversationHistory, currentSystemPrompt, analysisModel] = await Promise.all([
      Promise.resolve(this.getConversationHistory(agentId)),
      this.buildResolvedManagerPrompt(descriptor, { ignoreProjectAgentSystemPrompt: true }),
      this.resolveProjectAgentAnalysisModel()
    ]);

    return this.executeProjectAgentAnalysis(analysisModel.model, {
      conversationHistory,
      currentSystemPrompt,
      sessionAgentId: descriptor.agentId,
      sessionLabel: descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId,
      displayName: descriptor.displayName,
      profileId: descriptor.profileId,
      sessionCwd: descriptor.cwd,
      apiKey: analysisModel.apiKey,
      headers: analysisModel.headers
    });
  }

  async renameSession(agentId: string, label: string): Promise<void> {
    await this.sessionService.renameSession(agentId, label);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "renamed",
      sessionDescriptor: cloneDescriptor(this.getRequiredSessionDescriptor(agentId))
    });
  }

  async renameProfile(profileId: string, displayName: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }
    const normalizedName = displayName.trim();
    if (!normalizedName) {
      throw new Error("Profile display name must be non-empty");
    }
    profile.displayName = normalizedName;
    profile.updatedAt = this.now();
    this.profiles.set(profileId, profile);
    await this.saveStore();
    this.emitProfilesSnapshot();
    this.emitAgentsSnapshot();
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    return this.memoryMergeService.mergeSessionMemory(agentId);
  }

  async forkSession(
    sourceAgentId: string,
    options?: { label?: string; fromMessageId?: string }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = cloneDescriptor(this.getRequiredSessionDescriptor(sourceAgentId));
    const forkedSession = await this.sessionService.forkSession(sourceAgentId, options);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "forked",
      sessionDescriptor: forkedSession.sessionAgent,
      sourceDescriptor
    });
    return forkedSession;
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    return this.lifecycleService.spawnAgent(callerAgentId, input);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    await this.lifecycleService.killAgent(callerAgentId, targetAgentId);
  }

  async stopWorker(agentId: string): Promise<void> {
    await this.lifecycleService.stopWorker(agentId);
  }

  async resumeWorker(agentId: string): Promise<void> {
    await this.lifecycleService.resumeWorker(agentId);
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    return this.lifecycleService.stopAllAgents(callerAgentId, targetManagerId);
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const createdManager = await this.lifecycleService.createManager(callerAgentId, input);
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createdManager
    });
    return createdManager;
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    const profile = this.profiles.get(targetManagerId);
    const sessionDescriptors = profile ? this.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.descriptors.get(targetManagerId);
      if (target?.role === "manager") {
        sessionDescriptors.push(target);
      }
    }

    const deletedSessionDescriptors = sessionDescriptors.map((sessionDescriptor) => cloneDescriptor(sessionDescriptor));
    const result = await this.lifecycleService.deleteManager(callerAgentId, targetManagerId);

    for (const sessionDescriptor of deletedSessionDescriptors) {
      await this.forgeExtensionHost.dispatchSessionLifecycle({
        action: "deleted",
        sessionDescriptor
      });
    }

    return result;
  }

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    await this.settingsService.updateManagerModel(managerId, modelPreset, reasoningLevel);
  }

  async updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    return this.settingsService.updateManagerCwd(managerId, newCwd);
  }

  async notifyModelSpecificInstructionsChanged(modelKeys: string[]): Promise<void> {
    await this.settingsService.notifyModelSpecificInstructionsChanged(modelKeys);
  }

  private assertCanChangeManagerCwd(
    profileId: string,
    sessions: Array<AgentDescriptor & { role: "manager"; profileId: string }>
  ): void {
    if (
      profileId === CORTEX_PROFILE_ID ||
      sessions.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)
    ) {
      throw new Error("Cannot change working directory for Cortex profile");
    }
  }

  async notifySpecialistRosterChanged(profileId: string): Promise<void> {
    try {
      const roster = await this.resolveSpecialistRosterForProfile(profileId);
      await this.lifecycleService.syncWorkerSpecialistMetadata(profileId, roster);
    } catch (error) {
      this.logDebug("specialist:roster_change:sync:error", {
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const sessions = this.getSessionsForProfile(profileId);
    // Specialist edits are already persisted on disk. Runtime refresh is best-effort.
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "specialist_roster_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logDebug("specialist:roster_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    const sessions = this.getSessionsForProfile(profileId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.applyManagerRuntimeRecyclePolicy(session.agentId, "project_agent_directory_change")),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logDebug("project_agents:directory_change:recycle:error", {
          profileId,
          agentId: sessions[index]?.agentId,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  private async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason: ManagerRuntimeRecycleReason
  ): Promise<"recycled" | "deferred" | "none"> {
    return this.lifecycleService.applyManagerRuntimeRecyclePolicy(agentId, reason);
  }

  async previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    return this.promptService.previewManagerSystemPrompt(profileId);
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptor(descriptor);
  }

  async getProjectAgentConfig(agentId: string): Promise<{
    config: import("@forge/protocol").PersistedProjectAgentConfig;
    systemPrompt: string | null;
    references: string[];
  }> {
    return this.projectAgentService.getProjectAgentConfig(agentId);
  }

  async listProjectAgentReferences(agentId: string): Promise<string[]> {
    return this.projectAgentService.listProjectAgentReferences(agentId);
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    return this.projectAgentService.getProjectAgentReference(agentId, fileName);
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string): Promise<void> {
    await this.projectAgentService.setProjectAgentReference(agentId, fileName, content);
  }

  async deleteProjectAgentReference(agentId: string, fileName: string): Promise<void> {
    await this.projectAgentService.deleteProjectAgentReference(agentId, fileName);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return this.settingsService.listDirectories(path);
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return this.settingsService.validateDirectory(path);
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return this.settingsService.pickDirectory(defaultPath);
  }

  private isSessionAgent(
    descriptor: AgentDescriptor | undefined
  ): descriptor is AgentDescriptor & { role: "manager"; profileId: string } {
    return (
      !!descriptor &&
      descriptor.role === "manager" &&
      typeof descriptor.profileId === "string" &&
      descriptor.profileId.trim().length > 0
    );
  }

  private getRequiredSessionDescriptor(
    agentId: string
  ): AgentDescriptor & { role: "manager"; profileId: string } {
    const descriptor = this.descriptors.get(agentId);
    if (!this.isSessionAgent(descriptor)) {
      throw new Error(`Unknown session agent: ${agentId}`);
    }

    return descriptor;
  }

  private assertSessionSupportsProjectAgent(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string }
  ): void {
    if (descriptor.agentId === CORTEX_PROFILE_ID && descriptor.profileId === CORTEX_PROFILE_ID) {
      throw new Error("Cortex root cannot be promoted to a project agent");
    }

    if (descriptor.sessionPurpose === "cortex_review") {
      throw new Error("Cortex review sessions cannot be promoted to project agents");
    }

    if (descriptor.sessionPurpose === "agent_creator") {
      throw new Error("Agent creator sessions cannot be promoted to project agents");
    }
  }

  private buildProjectAgentInfoForSession(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    whenToUse: string,
    systemPrompt?: string,
    handle?: string,
    capabilities?: NonNullable<AgentDescriptor["projectAgent"]>["capabilities"]
  ): NonNullable<AgentDescriptor["projectAgent"]> {
    const normalizedWhenToUse = normalizeProjectAgentInlineText(whenToUse);
    if (!normalizedWhenToUse) {
      throw new Error("Project agent \"When to use\" must be non-empty");
    }

    if (normalizedWhenToUse.length > 280) {
      throw new Error("Project agent \"When to use\" must be 280 characters or fewer");
    }

    const normalizedHandle = normalizeProjectAgentHandle(handle ?? getProjectAgentPublicName(descriptor));
    if (!normalizedHandle) {
      throw new Error(
        "Project agent handle must contain at least one letter, number, or dash. Provide an explicit handle or use a session name with at least one letter, number, or dash."
      );
    }

    const existingProjectAgent = findProjectAgentByHandle(this.descriptors.values(), descriptor.profileId, normalizedHandle);
    if (existingProjectAgent && existingProjectAgent.agentId !== descriptor.agentId) {
      throw new Error(getProjectAgentHandleCollisionError(normalizedHandle));
    }

    const normalizedSystemPrompt = systemPrompt?.trim();

    return {
      handle: normalizedHandle,
      whenToUse: normalizedWhenToUse,
      // DUAL-WRITE: systemPrompt kept in agents.json mirror for Electron rollback safety
      ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
      ...(descriptor.projectAgent?.creatorSessionId !== undefined
        ? { creatorSessionId: descriptor.projectAgent.creatorSessionId }
        : {}),
      ...(capabilities !== undefined ? { capabilities: [...capabilities] } : {})
    };
  }

  private getSessionsForProfile(profileId: string): AgentDescriptor[] {
    return Array.from(this.descriptors.values()).filter(
      (descriptor) => descriptor.role === "manager" && descriptor.profileId === profileId
    );
  }

  private getWorkersForManager(managerId: string): AgentDescriptor[] {
    return Array.from(this.descriptors.values()).filter(
      (descriptor) => descriptor.role === "worker" && descriptor.managerId === managerId
    );
  }

  private buildManagerSnapshotDescriptors(options: { includeStreamingWorkers: boolean }): AgentDescriptor[] {
    const managers = this.sortedDescriptors()
      .filter((descriptor) => descriptor.role === "manager")
      .map((descriptor) => this.cloneManagerDescriptorWithWorkerCounts(descriptor));

    if (!options.includeStreamingWorkers) {
      return managers;
    }

    const hotWorkers = this.sortedDescriptors()
      .filter((descriptor) => descriptor.role === "worker" && descriptor.status === "streaming")
      .map((descriptor) => cloneDescriptor(descriptor));

    return [...managers, ...hotWorkers];
  }

  private cloneManagerDescriptorWithWorkerCounts(descriptor: AgentDescriptor): AgentDescriptor {
    const clone = cloneDescriptor(descriptor);
    const workers = this.getWorkersForManager(clone.agentId);
    clone.workerCount = workers.length;
    clone.activeWorkerCount = workers.filter((worker) => worker.status === "streaming").length;
    clone.pendingChoiceCount = this.getPendingChoiceIdsForSession(clone.agentId).length;
    return clone;
  }

  private isSessionAgentIdReserved(profileId: string, agentId: string): boolean {
    if (this.descriptors.has(agentId)) {
      return true;
    }

    return existsSync(getSessionDir(this.config.paths.dataDir, profileId, agentId));
  }

  private generateSessionAgentIdentity(profileId: string): { agentId: string; sessionNumber: number } {
    const existingSessions = this.getSessionsForProfile(profileId);
    let highestSessionNumber = existingSessions.some((descriptor) => descriptor.agentId === profileId)
      ? ROOT_SESSION_NUMBER
      : 0;

    for (const descriptor of existingSessions) {
      const parsedSessionNumber = parseSessionNumberFromAgentId(descriptor.agentId, profileId);
      if (parsedSessionNumber !== undefined) {
        highestSessionNumber = Math.max(highestSessionNumber, parsedSessionNumber);
      }
    }

    let nextSessionNumber = Math.max(ROOT_SESSION_NUMBER + 1, highestSessionNumber + 1);
    let sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;

    while (this.isSessionAgentIdReserved(profileId, sessionAgentId)) {
      nextSessionNumber += 1;
      sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;
    }

    return {
      agentId: sessionAgentId,
      sessionNumber: nextSessionNumber
    };
  }

  private generateUniqueSessionAgentId(profileId: string, baseAgentId: string): string {
    let candidate = baseAgentId;
    let suffix = 2;

    while (this.isSessionAgentIdReserved(profileId, candidate)) {
      candidate = `${baseAgentId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private prepareSessionCreation(
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ): { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number } {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    if (options?.sessionPurpose === "agent_creator" && profileId === CORTEX_PROFILE_ID) {
      throw new Error("Agent creator sessions cannot be created in the Cortex profile");
    }

    const templateDescriptor = this.descriptors.get(profile.defaultSessionAgentId);
    if (!templateDescriptor || templateDescriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    const { agentId: autoSessionAgentId, sessionNumber } = this.generateSessionAgentIdentity(profileId);
    const normalizedName = options?.name?.trim();
    const normalizedLabel = options?.label?.trim();

    let sessionAgentId = autoSessionAgentId;
    let sessionLabel = normalizedLabel && normalizedLabel.length > 0
      ? normalizedLabel
      : `Session ${sessionNumber}`;
    let displayName = normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : sessionAgentId;

    if (normalizedName && normalizedName.length > 0) {
      const slug = slugifySessionName(normalizedName);
      if (!slug) {
        throw new Error("Session name must include at least one letter, number, or dash");
      }

      sessionAgentId = this.generateUniqueSessionAgentId(profileId, slug);
      sessionLabel = normalizedName;
      displayName = normalizedName;
    }

    const createdAt = this.now();

    const sessionDescriptor: AgentDescriptor = {
      agentId: sessionAgentId,
      displayName,
      role: "manager",
      managerId: sessionAgentId,
      archetypeId: templateDescriptor.archetypeId,
      profileId: profile.profileId,
      sessionLabel,
      sessionPurpose: options?.sessionPurpose,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: templateDescriptor.cwd,
      model: { ...templateDescriptor.model },
      sessionFile: getSessionFilePath(this.config.paths.dataDir, profile.profileId, sessionAgentId)
    };

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      sessionDescriptor.archetypeId = "agent-architect";
      if (!sessionDescriptor.sessionLabel || sessionDescriptor.sessionLabel === `Session ${sessionNumber}`) {
        sessionDescriptor.sessionLabel = "Agent Creator";
        sessionDescriptor.displayName = "Agent Creator";
      }
    }

    return {
      profile,
      sessionDescriptor,
      sessionNumber
    };
  }

  private async appendSessionRenameHistoryEntry(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    entry: SessionRenameHistoryEntry
  ): Promise<void> {
    const sessionDir = getSessionDir(this.config.paths.dataDir, descriptor.profileId, descriptor.agentId);
    const historyPath = join(sessionDir, "rename-history.json");
    const entries: SessionRenameHistoryEntry[] = [];

    try {
      const existing = await readFile(historyPath, "utf8");
      const parsed = JSON.parse(existing) as unknown;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isSessionRenameHistoryEntry(item)) {
            entries.push(item);
          }
        }
      } else if (existing.trim().length > 0) {
        throw new Error(`Invalid rename history format for session ${descriptor.agentId}`);
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    entries.push(entry);

    await mkdir(sessionDir, { recursive: true });
    await writeFile(historyPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  }

  private assertSessionIsDeletable(descriptor: AgentDescriptor): void {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.profiles.get(profileId);
    const defaultSessionAgentId = profile?.defaultSessionAgentId ?? profileId;

    if (descriptor.agentId === defaultSessionAgentId) {
      throw new Error(`Cannot delete default session: ${descriptor.agentId}`);
    }
  }

  private async stopSessionInternal(
    agentId: string,
    options: AgentLifecycleStopSessionOptions
  ): Promise<{ terminatedWorkerIds: string[] }> {
    return this.lifecycleService.stopSessionInternal(agentId, options);
  }

  private async copySessionHistoryForFork(
    sourceSessionFile: string,
    targetSessionFile: string,
    fromMessageId?: string
  ): Promise<void> {
    await mkdir(dirname(targetSessionFile), { recursive: true });

    const sourceHandle = await open(sourceSessionFile, "r").catch((error: unknown) => {
      if (isEnoentError(error)) {
        return undefined;
      }
      throw error;
    });

    if (!sourceHandle) {
      if (fromMessageId) {
        throw new Error("Message not found in session history");
      }

      await writeFile(targetSessionFile, "", "utf8");
      return;
    }

    const targetHandle = await open(targetSessionFile, "w");
    let foundForkPoint = !fromMessageId;

    try {
      for await (const line of sourceHandle.readLines()) {
        if (!this.shouldCopySessionHistoryLineForFork(line)) {
          continue;
        }

        await targetHandle.write(`${line}\n`);

        if (fromMessageId && this.isForkTargetConversationEntryLine(line, fromMessageId)) {
          foundForkPoint = true;
          break;
        }
      }
    } finally {
      await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
    }

    if (!foundForkPoint) {
      throw new Error("Message not found in session history");
    }
  }

  private shouldCopySessionHistoryLineForFork(line: string): boolean {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return true;
    }

    let parsedEntry: unknown;
    try {
      parsedEntry = JSON.parse(trimmedLine);
    } catch {
      return true;
    }

    return !(
      isRecord(parsedEntry) &&
      parsedEntry.type === "custom" &&
      parsedEntry.customType === CLAUDE_RUNTIME_STATE_ENTRY_TYPE
    );
  }

  private isForkTargetConversationEntryLine(line: string, fromMessageId: string): boolean {
    const conversationEntry = this.parseConversationMessageEntryLine(line);
    if (!conversationEntry) {
      return false;
    }

    return conversationEntry.id === fromMessageId;
  }

  private parseConversationMessageEntryLine(line: string): { id?: string } | undefined {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return undefined;
    }

    let parsedEntry: unknown;
    try {
      parsedEntry = JSON.parse(trimmedLine);
    } catch {
      return undefined;
    }

    if (!isRecord(parsedEntry)) {
      return undefined;
    }

    if (
      parsedEntry.type !== "custom" ||
      parsedEntry.customType !== "swarm_conversation_entry"
    ) {
      return undefined;
    }

    if (typeof parsedEntry.id === "string" && parsedEntry.id.trim().length > 0) {
      return { id: parsedEntry.id };
    }

    if (!isRecord(parsedEntry.data)) {
      return undefined;
    }

    const dataId = parsedEntry.data.id;
    if (typeof dataId === "string" && dataId.trim().length > 0) {
      return { id: dataId };
    }

    return undefined;
  }

  private async copyPinnedMessagesForFork(
    sourceDescriptor: AgentDescriptor & { role: "manager"; profileId: string },
    forkedDescriptor: AgentDescriptor & { role: "manager"; profileId: string }
  ): Promise<void> {
    const sourceRegistry = await loadPins(this.getSessionDirForDescriptor(sourceDescriptor));
    if (Object.keys(sourceRegistry.pins).length === 0) {
      this.setPinnedRegistryForAgent(forkedDescriptor.agentId, { version: 1, pins: {} });
      return;
    }

    const forkedMessageIds = await this.collectConversationMessageIdsFromSessionFile(forkedDescriptor.sessionFile);
    const filteredRegistry: PinRegistry = {
      version: 1,
      pins: Object.fromEntries(
        Object.entries(sourceRegistry.pins).filter(([messageId]) => forkedMessageIds.has(messageId))
      )
    };

    if (Object.keys(filteredRegistry.pins).length === 0) {
      this.setPinnedRegistryForAgent(forkedDescriptor.agentId, filteredRegistry);
      return;
    }

    await savePins(this.getSessionDirForDescriptor(forkedDescriptor), filteredRegistry);
    this.setPinnedRegistryForAgent(forkedDescriptor.agentId, filteredRegistry);
  }

  private async collectConversationMessageIdsFromSessionFile(sessionFile: string): Promise<Set<string>> {
    const messageIds = new Set<string>();

    const handle = await open(sessionFile, "r").catch((error: unknown) => {
      if (isEnoentError(error)) {
        return undefined;
      }
      throw error;
    });

    if (!handle) {
      return messageIds;
    }

    try {
      for await (const line of handle.readLines()) {
        const conversationEntry = this.parseConversationMessageEntryLine(line);
        if (!conversationEntry?.id) {
          continue;
        }

        messageIds.add(conversationEntry.id);
      }
    } finally {
      await handle.close();
    }

    return messageIds;
  }

  private async writeForkedSessionMemoryHeader(
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string
  ): Promise<void> {
    const sourceLabel = sourceDescriptor.sessionLabel ?? sourceDescriptor.agentId;
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const forkHistoryNote = fromMessageId
      ? `Parent session conversation history was copied through message ${fromMessageId} at fork time.`
      : "Parent session conversation history was duplicated at fork time.";
    const headerTemplate = await this.resolvePromptWithFallback(
      "operational",
      "forked-session-header",
      profileId,
      FORKED_SESSION_MEMORY_HEADER_TEMPLATE
    );
    let header = resolvePromptVariables(headerTemplate, {
      SOURCE_LABEL: sourceLabel,
      SOURCE_AGENT_ID: sourceDescriptor.agentId,
      FORK_TIMESTAMP: this.now(),
      FORK_HISTORY_NOTE: forkHistoryNote,
      FROM_MESSAGE_ID: fromMessageId ?? ""
    });

    if (fromMessageId && !header.includes(fromMessageId)) {
      header = `${header.trimEnd()}\n> ${forkHistoryNote}\n`;
    }

    const forkedMemoryPath = this.getAgentMemoryPath(forkedSessionAgentId);
    await mkdir(dirname(forkedMemoryPath), { recursive: true });
    await writeFile(forkedMemoryPath, header, "utf8");
    await this.refreshSessionMetaStatsBySessionId(forkedSessionAgentId);
  }

  private resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
    const managerContextIds = new Set<string>();

    for (const descriptor of agents) {
      if (descriptor.role === "manager") {
        managerContextIds.add(descriptor.agentId);
        continue;
      }

      const managerId = descriptor.managerId.trim();
      if (managerId.length > 0) {
        managerContextIds.add(managerId);
      }
    }

    return Array.from(managerContextIds);
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ): Promise<SendMessageReceipt> {
    const sender = this.descriptors.get(fromAgentId);
    if (!sender || isNonRunningAgentStatus(sender.status)) {
      throw new Error(`Unknown or unavailable sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    if (sender.role === "worker" && target.role === "manager" && sender.managerId !== target.agentId) {
      throw new Error(
        `Worker ${sender.agentId} cannot message manager ${targetAgentId} (own manager is ${sender.managerId})`
      );
    }

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const isProjectAgentDelivery =
      sender.role === "manager" &&
      target.role === "manager" &&
      fromAgentId !== targetAgentId &&
      (sender.profileId ?? sender.agentId) === (target.profileId ?? target.agentId) &&
      (target.projectAgent !== undefined || target.creatorAgentId === fromAgentId);

    if (isProjectAgentDelivery) {
      const receipt = await deliverProjectAgentMessage(
        {
          now: this.now,
          getOrCreateRuntimeForDescriptor: (descriptor) => this.getOrCreateRuntimeForDescriptor(descriptor),
          emitConversationMessage: (event) => this.emitConversationMessage(event),
          markSessionActivity: (agentId, timestamp) => this.markSessionActivity(agentId, timestamp),
          rateLimitBuckets: this.projectAgentMessageTimestampsBySender
        },
        {
          sender,
          target,
          message,
          delivery
        }
      );

      this.logDebug("agent:send_message", {
        fromAgentId,
        targetAgentId,
        origin,
        requestedDelivery: delivery,
        acceptedMode: receipt.acceptedMode,
        textPreview: previewForLog(message),
        attachmentCount: attachments.length,
        modelTextPreview: previewForLog(
          formatProjectAgentRuntimeMessage(
            {
              fromAgentId,
              fromDisplayName: getProjectAgentPublicName(sender)
            },
            message
          )
        )
      });

      if (origin !== "user" && fromAgentId !== targetAgentId) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: sender.agentId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }

      return receipt;
    }

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = await this.getOrCreateRuntimeForDescriptor(target);

    const watchdogTurnSeqAtDispatch = this.workerHealthService.getWorkerReportDispatchTurnSeq(sender, target);

    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );

    this.workerHealthService.markPendingWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);

    let receipt: SendMessageReceipt;
    try {
      receipt = await runtime.sendMessage(modelMessage, delivery);
    } catch (error) {
      await this.workerHealthService.handleFailedWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);
      throw error;
    }

    await this.workerHealthService.handleSuccessfulWorkerReportDispatch(sender.agentId, watchdogTurnSeqAtDispatch);

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery: delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    if (origin !== "user" && fromAgentId !== targetAgentId) {
      for (const managerContextId of managerContextIds) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: managerContextId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }
    }

    return receipt;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      if (text.trim().length > 0 && !/^system:/i.test(text.trimStart())) {
        text = `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1, "bin");
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: Pick<ConversationBinaryAttachment, "data" | "fileName">,
    attachmentIndex: number,
    fallbackExtension: string
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(
      attachment.fileName,
      `attachment-${attachmentIndex}.${fallbackExtension}`
    );
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async persistConversationAttachmentsIfNeeded(
    attachments: ConversationAttachment[]
  ): Promise<ConversationAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    return persistConversationAttachments(attachments, this.config.paths.uploadsDir);
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    let resolvedTargetContext: MessageSourceContext;
    let normalizedText = text;

    if (source === "speak_to_user") {
      const descriptor = this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);

      if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        normalizedText = normalizeCortexUserVisiblePaths(text);
      }
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text: normalizedText,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    if (source === "speak_to_user") {
      this.markSessionActivity(agentId, payload.timestamp);
    }

    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(normalizedText)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  private async resolveCompactionCustomInstructions(
    descriptor: AgentDescriptor & { role: "manager" },
    customInstructions?: string
  ): Promise<string | undefined> {
    const registry = await this.syncPinnedContentForManagerRuntime(descriptor);
    return combineCompactionCustomInstructions(customInstructions, registry);
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    const managerDescriptor = descriptor as AgentDescriptor & { role: "manager" };
    const runtime = await this.getOrCreateRuntimeForDescriptor(managerDescriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = await this.resolveCompactionCustomInstructions(
      managerDescriptor,
      options?.customInstructions?.trim() || undefined
    );

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Compacting manager context...",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      // Track successful compaction count
      const newCount = await this.incrementSessionCompactionCount(
        descriptor.profileId!,
        agentId,
        "manager:compact:count-increment-failed"
      );
      if (newCount !== undefined) {
        descriptor.compactionCount = newCount;
      }

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async smartCompactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Smart compaction is only supported for manager agents: ${agentId}`);
    }

    const managerDescriptor = descriptor as AgentDescriptor & { role: "manager" };
    const runtime = await this.getOrCreateRuntimeForDescriptor(managerDescriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = await this.resolveCompactionCustomInstructions(
      managerDescriptor,
      options?.customInstructions?.trim() || undefined
    );

    this.logDebug("manager:smart_compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Running smart compaction (handoff → compact → resume)…",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.smartCompact(customInstructions);

      if (result.compacted) {
        // Track successful smart compaction
        const smartCount = await this.incrementSessionCompactionCount(
          descriptor.profileId!,
          agentId,
          "manager:smart_compact:count-increment-failed"
        );
        if (smartCount !== undefined) {
          descriptor.compactionCount = smartCount;
        }

        const usage = runtime.getContextUsage();
        const usageSuffix = usage ? ` Context now at ${Math.round(usage.percent)}%.` : "";
        this.emitConversationMessage({
          type: "conversation_message",
          agentId,
          role: "system",
          text: `Smart compaction complete.${usageSuffix}`,
          timestamp: this.now(),
          source: "system",
          sourceContext
        });
      } else {
        const text =
          runtime.runtimeType === "claude" && result.reason === "claude_runtime_below_compaction_threshold"
            ? "Smart compaction skipped because context is already below the Claude compaction threshold."
            : `Smart compaction finished but context was not reduced (${result.reason}). The handoff note was written and a resume prompt was sent, but compaction did not succeed.`;
        this.emitConversationMessage({
          type: "conversation_message",
          agentId,
          role: "system",
          text,
          timestamp: this.now(),
          source: "system",
          sourceContext
        });
      }

      this.logDebug("manager:smart_compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
        compacted: result.compacted,
        reason: result.compacted ? undefined : result.reason
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Smart compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:smart_compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    const targetAgentId = options?.targetAgentId ?? this.resolvePreferredManagerId();
    if (!targetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (isNonRunningAgentStatus(target.status)) {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (target.role === "manager" && attachments.length === 0) {
      const routedReviewRun = await this.maybeStartCortexReviewRunFromIncomingMessage(trimmed, target, sourceContext);
      if (routedReviewRun) {
        return;
      }
    }

    const persistedAttachments = await this.persistConversationAttachmentsIfNeeded(attachments);
    const attachmentMetadata = toConversationAttachmentMetadata(
      persistedAttachments,
      this.config.paths.uploadsDir
    );
    const runtimeAttachments = toRuntimeDispatchAttachments(attachments, persistedAttachments);

    const receivedAt = this.now();
    const compactCommand =
      target.role === "manager" && persistedAttachments.length === 0 ? parseCompactSlashCommand(trimmed) : undefined;
    if (compactCommand) {
      this.markSessionActivity(targetAgentId, receivedAt);
      this.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? "")
      });
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: persistedAttachments.length
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachmentMetadata.length > 0 ? attachmentMetadata : undefined,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext
    };
    this.emitConversationMessage(userEvent);
    this.markSessionActivity(targetAgentId, receivedAt);


    if (target.role !== "manager") {
      const requestedDelivery = options?.delivery ?? "auto";
      let receipt: SendMessageReceipt;
      try {
        receipt = await this.sendMessage(managerContextId, targetAgentId, trimmed, requestedDelivery, {
          origin: "user",
          attachments: runtimeAttachments
        });
      } catch (error) {
        this.logDebug("manager:user_message_dispatch_error", {
          managerContextId,
          targetAgentId,
          targetRole: target.role,
          requestedDelivery,
          sourceContext,
          textPreview: previewForLog(trimmed),
          attachmentCount: persistedAttachments.length,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachments.length
      });

      this.emitAgentMessage({
        type: "agent_message",
        agentId: managerContextId,
        timestamp: this.now(),
        source: "user_to_agent",
        toAgentId: targetAgentId,
        text: trimmed,
        sourceContext,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        attachmentCount: persistedAttachments.length > 0 ? persistedAttachments.length : undefined
      });
      return;
    }

    if (this.pendingManagerRuntimeRecycleAgentIds.has(target.agentId)) {
      const recycleDisposition = await this.applyManagerRuntimeRecyclePolicy(target.agentId, "idle_transition");
      if (recycleDisposition === "recycled") {
        await this.saveStore();
        this.emitAgentsSnapshot();
      }
    }

    let managerRuntime: SwarmAgentRuntime;
    try {
      managerRuntime = await this.getOrCreateRuntimeForDescriptor(target);
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: persistedAttachments.length,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }

    const managerVisibleMessage = formatInboundUserMessageForManager(trimmed, sourceContext);

    // User messages to managers should always steer in-flight work.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: managerVisibleMessage,
        attachments: runtimeAttachments
      },
      "user"
    );

    this.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery: "steer",
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: persistedAttachments.length,
      runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0)
    });

    try {
      const receipt = await managerRuntime.sendMessage(runtimeMessage, "steer");
      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: persistedAttachments.length
      });

    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: persistedAttachments.length,
        runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
        runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  private async maybeStartCortexReviewRunFromIncomingMessage(
    text: string,
    target: AgentDescriptor,
    sourceContext: MessageSourceContext
  ): Promise<boolean> {
    return this.cortexService.maybeStartReviewRunFromIncomingMessage(text, target, sourceContext);
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);
    const profileId = managerDescriptor.profileId ?? managerDescriptor.agentId;

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      profileId
    });

    const { sessionAgent } = await this.createSession(profileId, { label: "New chat" });

    this.emitConversationReset(managerId, reason);

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      profileId,
      newSessionAgentId: sessionAgent.agentId
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  getVersioningService(): VersioningMutationSink | undefined {
    return this.versioningService;
  }

  async reloadModelCatalogOverridesAndProjection(): Promise<void> {
    await modelCatalogService.loadOverrides(this.config.paths.dataDir);
    await this.refreshPiModelsJsonProjection();
  }

  async reloadOpenRouterModelsAndProjection(): Promise<void> {
    await modelCatalogService.reloadOpenRouterModels();
    await this.refreshPiModelsJsonProjection();
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return this.runtimeController.listRuntimeExtensionSnapshots();
  }

  async buildForgeExtensionSettingsSnapshot(options: { cwdValues: string[] }) {
    return this.forgeExtensionHost.buildSettingsSnapshot(options);
  }

  async dispatchForgeVersioningCommit(event: ForgeVersioningCommitEvent): Promise<void> {
    await this.forgeExtensionHost.dispatchVersioningCommit(event);
  }

  setIntegrationContextProvider(provider?: (profileId: string) => string): void {
    this.integrationContextProvider = provider;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.settingsService.listSettingsEnv();
  }

  async listSkillMetadata(profileId?: string): Promise<SkillInventoryEntry[]> {
    return this.settingsService.listSkillMetadata(profileId);
  }

  async listSkillFiles(skillId: string, relativePath = ""): Promise<SkillFilesResponse> {
    return this.settingsService.listSkillFiles(skillId, relativePath);
  }

  async getSkillFileContent(skillId: string, relativePath: string): Promise<SkillFileContentResponse> {
    return this.settingsService.getSkillFileContent(skillId, relativePath);
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.settingsService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.settingsService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.settingsService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.settingsService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.settingsService.deleteSettingsAuth(provider);
  }

  // ── Credential Pool pass-through ──

  getCredentialPoolService(): CredentialPoolService {
    return this.settingsService.getCredentialPoolService();
  }

  async listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.settingsService.listCredentialPool(provider);
  }

  async renamePooledCredential(provider: string, credentialId: string, label: string): Promise<void> {
    await this.settingsService.renamePooledCredential(provider, credentialId, label);
  }

  async removePooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.removePooledCredential(provider, credentialId);
  }

  async setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.setPrimaryPooledCredential(provider, credentialId);
  }

  async setCredentialPoolStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    await this.settingsService.setCredentialPoolStrategy(provider, strategy);
  }

  async resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    await this.settingsService.resetPooledCredentialCooldown(provider, credentialId);
  }

  async addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    return this.settingsService.addPooledCredential(provider, oauthCredential, identity);
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.conversationProjector.emitConversationMessage(event);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.conversationProjector.emitAgentMessage(event);
  }

  private emitChoiceRequest(event: ChoiceRequestEvent): void {
    this.conversationProjector.emitChoiceRequest(event);
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.conversationProjector.emitConversationReset(agentId, reason);
  }

  private emitMessagePinned(agentId: string, messageId: string, pinned: boolean, timestamp: string): void {
    this.emit(
      "message_pinned",
      {
        type: "message_pinned",
        agentId,
        messageId,
        pinned,
        timestamp
      } satisfies ServerEvent
    );
  }

  private markSessionActivity(agentId: string, timestamp?: string): void {
    const sessionAgentId = this.resolveSessionActivityAgentId(agentId);
    if (!sessionAgentId) {
      return;
    }

    const descriptor = this.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const normalizedTimestamp = normalizeOptionalAgentId(timestamp) ?? this.now();
    if (descriptor.updatedAt.localeCompare(normalizedTimestamp) >= 0) {
      return;
    }

    descriptor.updatedAt = normalizedTimestamp;
    this.descriptors.set(sessionAgentId, descriptor);
    this.emitAgentsSnapshot();
  }

  private resolveSessionActivityAgentId(agentId: string): string | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerDescriptor = this.descriptors.get(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return undefined;
    }

    return managerDescriptor.agentId;
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private getConfiguredManagerId(): string | undefined {
    return normalizeOptionalAgentId(this.config.managerId);
  }

  private resolvePreferredManagerId(options?: { includeStoppedOnRestart?: boolean }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return configuredManagerId;
      }
    }

    const firstManager = Array.from(this.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean
  ): boolean {
    if (descriptor.role !== "manager") {
      return false;
    }

    if (descriptor.status === "terminated" || descriptor.status === "error") {
      return false;
    }

    if (!includeStoppedOnRestart && descriptor.status === "stopped") {
      return false;
    }

    return true;
  }

  private sortedDescriptors(): AgentDescriptor[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  /**
   * Ensures every profile has an explicit sortOrder.
   * Called on first profile creation after upgrade so legacy profiles
   * (which have sortOrder: undefined) get values matching their current
   * visible order, preventing new profiles from sorting before them.
   */
  private materializeSortOrder(): void {
    const needsMaterialization = Array.from(this.profiles.values()).some(
      (p) => p.sortOrder === undefined || p.sortOrder === null
    );
    if (!needsMaterialization) return;

    const sorted = this.sortedProfiles();
    for (let i = 0; i < sorted.length; i++) {
      const profile = this.profiles.get(sorted[i].profileId);
      if (profile) {
        profile.sortOrder = i;
        this.profiles.set(profile.profileId, profile);
      }
    }
  }

  async reorderProfiles(profileIds: string[]): Promise<void> {
    // Validate: profileIds must contain exactly the current non-Cortex profile IDs
    const currentProfiles = Array.from(this.profiles.values());

    const reorderableIds = new Set(
      currentProfiles
        .filter((p) => p.profileId !== CORTEX_PROFILE_ID)
        .map((p) => p.profileId)
    );

    const incomingIds = new Set(profileIds);
    if (incomingIds.size !== profileIds.length) {
      throw new Error("Duplicate profile IDs in reorder request");
    }
    if (incomingIds.size !== reorderableIds.size) {
      throw new Error("Profile ID count mismatch: expected " + reorderableIds.size + " but got " + incomingIds.size);
    }
    for (const id of profileIds) {
      if (!reorderableIds.has(id)) {
        throw new Error("Unknown or non-reorderable profile ID: " + id);
      }
    }

    // Assign sortOrder values
    for (let i = 0; i < profileIds.length; i++) {
      const profile = this.profiles.get(profileIds[i]);
      if (profile) {
        profile.sortOrder = i;
        this.profiles.set(profile.profileId, profile);
      }
    }

    await this.saveStore();
    this.emitProfilesSnapshot();
  }

  private sortedProfiles(): ManagerProfile[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.profiles.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.profileId === configuredManagerId) return -1;
        if (b.profileId === configuredManagerId) return 1;
      }

      // Sort by explicit sortOrder first (when present)
      const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.profileId.localeCompare(b.profileId);
    });
  }

  private async sendManagerBootstrapMessage(managerId: string): Promise<void> {
    const manager = this.descriptors.get(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    if (isNonRunningAgentStatus(manager.status)) {
      return;
    }

    if (!this.runtimes.has(managerId)) {
      return;
    }

    const profileId = manager.profileId ?? manager.agentId;

    await this.resolvePromptWithFallback(
      "operational",
      "idle-watchdog",
      profileId,
      IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE
    );

    try {
      const bootstrapMessage = await this.resolvePromptWithFallback(
        "operational",
        "bootstrap",
        profileId,
        MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE
      );
      await this.sendMessage(managerId, managerId, bootstrapMessage, "auto", {
        origin: "internal"
      });
      this.logDebug("manager:bootstrap_message:sent", { managerId });
    } catch (error) {
      this.logDebug("manager:bootstrap_message:error", {
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async injectAgentCreatorContext(sessionAgentId: string, profileId: string): Promise<void> {
    try {
      const sources = await gatherAgentCreatorContext(
        this.config.paths.dataDir,
        profileId,
        this.descriptors.values(),
        sessionAgentId
      );
      const contextText = formatAgentCreatorContextMessage(sources);

      if (!contextText.trim()) {
        this.logDebug("agent_creator:context:empty", { sessionAgentId, profileId });
        return;
      }

      await this.sendMessage(sessionAgentId, sessionAgentId, contextText, "auto", {
        origin: "internal"
      });
      this.logDebug("agent_creator:context:injected", {
        sessionAgentId,
        profileId,
        agentCount: sources.existingAgents.length,
        recentSessionCount: sources.recentSessions.length
      });
    } catch (error) {
      this.logDebug("agent_creator:context:error", {
        sessionAgentId,
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolvePromptWithFallback(
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string
  ): Promise<string> {
    try {
      return await this.promptRegistry.resolve(category, promptId, profileId);
    } catch (error) {
      this.logDebug("prompt:resolve:fallback", {
        category,
        promptId,
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
      return fallback;
    }
  }

  private reconcileProfilesOnBoot(): void {
    const managerDescriptorsById = new Map<string, AgentDescriptor>();

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      const reconciledProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
      if (descriptor.profileId !== reconciledProfileId) {
        descriptor.profileId = reconciledProfileId;
        this.descriptors.set(descriptor.agentId, descriptor);
      }

      managerDescriptorsById.set(descriptor.agentId, descriptor);

      if (this.profiles.has(reconciledProfileId)) {
        continue;
      }

      this.profiles.set(reconciledProfileId, {
        profileId: reconciledProfileId,
        displayName: descriptor.displayName,
        defaultSessionAgentId: reconciledProfileId,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.createdAt
      });
    }

    for (const [profileId, profile] of Array.from(this.profiles.entries())) {
      const defaultSessionDescriptor = managerDescriptorsById.get(profile.defaultSessionAgentId);
      if (!defaultSessionDescriptor || defaultSessionDescriptor.role !== "manager") {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.profiles.delete(profileId);
          continue;
        }

        profile.defaultSessionAgentId = rootSessionDescriptor.agentId;
      }

      const profileSessions = this.getSessionsForProfile(profileId);
      if (profileSessions.length === 0) {
        const rootSessionDescriptor = managerDescriptorsById.get(profileId);
        if (!rootSessionDescriptor || rootSessionDescriptor.role !== "manager") {
          this.profiles.delete(profileId);
          continue;
        }

        rootSessionDescriptor.profileId = profileId;
        this.descriptors.set(rootSessionDescriptor.agentId, rootSessionDescriptor);
      }

      this.profiles.set(profileId, profile);
    }
  }

  private prunePersistedCortexStateForBoot(store: AgentsStoreFile): {
    store: AgentsStoreFile;
    pruned: boolean;
  } {
    if (this.config.cortexEnabled) {
      return { store, pruned: false };
    }

    const agents = Array.isArray(store.agents) ? store.agents : [];
    const profiles = Array.isArray(store.profiles) ? store.profiles : [];
    const removedManagerIds = new Set(
      agents
        .filter((descriptor) => (
          descriptor.role === "manager" && (
            descriptor.agentId === CORTEX_PROFILE_ID ||
            descriptor.profileId === CORTEX_PROFILE_ID ||
            descriptor.sessionPurpose === "cortex_review"
          )
        ))
        .map((descriptor) => descriptor.agentId)
    );
    const filteredAgents = agents.filter((descriptor) => !(
      descriptor.agentId === CORTEX_PROFILE_ID ||
      descriptor.profileId === CORTEX_PROFILE_ID ||
      descriptor.sessionPurpose === "cortex_review" ||
      removedManagerIds.has(descriptor.managerId)
    ));
    const filteredProfiles = profiles.filter((profile) => profile.profileId !== CORTEX_PROFILE_ID);
    const pruned = filteredAgents.length !== agents.length || filteredProfiles.length !== profiles.length;

    if (pruned) {
      this.logDebug("boot:cortex:pruned_disabled_state", {
        removedAgents: agents.length - filteredAgents.length,
        removedProfiles: profiles.length - filteredProfiles.length
      });
    }

    return {
      store: {
        ...store,
        agents: filteredAgents,
        profiles: filteredProfiles
      },
      pruned
    };
  }

  private async ensureCortexProfile(): Promise<void> {
    if (!this.config.cortexEnabled) {
      await this.ensureCommonKnowledgeFile();
      return;
    }

    if (this.hasCortexDescriptor()) {
      await this.ensureCommonKnowledgeFile();
      await this.ensureCortexWorkerPromptsFile();
      await this.ensureCortexOperationalFiles();
      return;
    }

    if (this.descriptors.has(CORTEX_PROFILE_ID)) {
      throw new Error(
        `Cannot auto-create Cortex profile because agentId "${CORTEX_PROFILE_ID}" is already in use`
      );
    }

    const createdAt = this.now();

    const descriptor: AgentDescriptor = {
      agentId: CORTEX_PROFILE_ID,
      displayName: CORTEX_DISPLAY_NAME,
      role: "manager",
      managerId: CORTEX_PROFILE_ID,
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: this.config.defaultCwd,
      model: resolveModelDescriptorFromPreset(this.defaultModelPreset),
      sessionFile: getSessionFilePath(this.config.paths.dataDir, CORTEX_PROFILE_ID, CORTEX_PROFILE_ID)
    };

    const profile: ManagerProfile = {
      profileId: CORTEX_PROFILE_ID,
      displayName: CORTEX_DISPLAY_NAME,
      defaultSessionAgentId: CORTEX_PROFILE_ID,
      createdAt,
      updatedAt: createdAt
    };

    this.descriptors.set(descriptor.agentId, descriptor);
    this.profiles.set(profile.profileId, profile);

    await this.ensureProfilePiDirectories(profile.profileId);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);
    await this.refreshSessionMetaStats(descriptor);
    await this.ensureCommonKnowledgeFile();
    await this.ensureCortexWorkerPromptsFile();
    await this.ensureCortexOperationalFiles();

    this.logDebug("cortex:profile:auto_created", {
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID
    });
  }

  private async ensureLegacyProfileKnowledgeReferenceDocs(): Promise<void> {
    await Promise.all(
      this.sortedProfiles().map(async (profile) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profile.profileId, {
          versioning: this.versioningService
        });
      })
    );
  }

  private hasCortexDescriptor(): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        return true;
      }
    }

    return false;
  }

  private async ensureCommonKnowledgeFile(): Promise<void> {
    const commonKnowledgePath = getCommonKnowledgePath(this.config.paths.dataDir);

    try {
      await readFile(commonKnowledgePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    const commonKnowledgeTemplate = await this.resolvePromptWithFallback(
      "operational",
      "common-knowledge-template",
      CORTEX_PROFILE_ID,
      COMMON_KNOWLEDGE_INITIAL_TEMPLATE
    );

    await mkdir(dirname(commonKnowledgePath), { recursive: true });
    await writeFile(commonKnowledgePath, commonKnowledgeTemplate, "utf8");
    this.queueVersioningMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "bootstrap",
      profileId: CORTEX_PROFILE_ID
    });
  }

  private async ensureCortexOperationalFiles(): Promise<void> {
    const knowledgeDir = dirname(getCortexReviewLogPath(this.config.paths.dataDir));
    const reviewLogPath = getCortexReviewLogPath(this.config.paths.dataDir);
    const reviewRunsPath = getCortexReviewRunsPath(this.config.paths.dataDir);
    const manifestsDir = getCortexPromotionManifestsDir(this.config.paths.dataDir);

    await mkdir(knowledgeDir, { recursive: true });

    try {
      await readFile(reviewLogPath, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }

      await writeFile(reviewLogPath, "", "utf8");
    }

    try {
      await readFile(reviewRunsPath, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }

      await writeFile(reviewRunsPath, `${JSON.stringify({ version: 1, runs: [] }, null, 2)}\n`, "utf8");
    }

    await mkdir(manifestsDir, { recursive: true });
  }

  private async ensureCortexWorkerPromptsFile(): Promise<void> {
    const workerPromptsPath = getCortexWorkerPromptsPath(this.config.paths.dataDir);
    const workerPromptTemplate = await this.resolvePromptWithFallback(
      "operational",
      "cortex-worker-prompts",
      CORTEX_PROFILE_ID,
      CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE
    );

    try {
      const existingContent = await readFile(workerPromptsPath, "utf8");
      if (!shouldUpgradeLegacyCortexWorkerPrompts(existingContent)) {
        return;
      }

      await backupLegacyCortexWorkerPrompts(workerPromptsPath, existingContent);
      await writeFile(workerPromptsPath, workerPromptTemplate, "utf8");
      this.queueVersioningMutation({
        path: workerPromptsPath,
        action: "write",
        source: "bootstrap",
        profileId: CORTEX_PROFILE_ID
      });
      this.logDebug("cortex:worker_prompts:auto_upgraded", {
        path: workerPromptsPath
      });
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(workerPromptsPath), { recursive: true });
    await writeFile(workerPromptsPath, workerPromptTemplate, "utf8");
    this.queueVersioningMutation({
      path: workerPromptsPath,
      action: "write",
      source: "bootstrap",
      profileId: CORTEX_PROFILE_ID
    });
  }

  private normalizeStreamingStatusesForBoot(): void {
    const normalizedAgentIds: string[] = [];

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.status !== "streaming") {
        continue;
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.updatedAt = this.now();
      this.descriptors.set(descriptor.agentId, descriptor);
      normalizedAgentIds.push(descriptor.agentId);
    }

    if (normalizedAgentIds.length > 0) {
      this.logDebug("boot:normalize_streaming_statuses", { normalizedAgentIds });
    }
  }

  /**
   * Recover worker descriptors from on-disk worker JSONL files for sessions
   * whose workers are missing from agents.json.
   *
   * This handles the case where workers were previously deleted from agents.json
   * on session stop. We scan each session's workers/ directory and recreate
   * terminated descriptors for any worker files that have no matching descriptor.
   */
  private async recoverMissingWorkerDescriptorsForBoot(): Promise<void> {
    const recoveredIds: string[] = [];

    // Build set of known worker agentIds
    const knownWorkerIds = new Set<string>();
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role === "worker") {
        knownWorkerIds.add(descriptor.agentId);
      }
    }

    // Scan each session's workers directory
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager" || !descriptor.profileId) {
        continue;
      }

      const profileId = descriptor.profileId;
      const workersDir = getWorkersDir(this.config.paths.dataDir, profileId, descriptor.agentId);

      let workerFiles: string[];
      try {
        workerFiles = await readdir(workersDir);
      } catch {
        continue; // No workers directory
      }

      for (const filename of workerFiles) {
        if (!filename.endsWith(".jsonl")) {
          continue;
        }

        const workerId = filename.slice(0, -".jsonl".length);
        if (knownWorkerIds.has(workerId)) {
          continue;
        }

        // Parse minimal metadata from the worker JSONL header
        const workerFilePath = getWorkerSessionFilePath(
          this.config.paths.dataDir, profileId, descriptor.agentId, workerId
        );

        try {
          const header = await this.readWorkerJSONLHeader(workerFilePath);

          const workerDescriptor: AgentDescriptor = {
            agentId: workerId,
            displayName: workerId,
            role: "worker",
            managerId: descriptor.agentId,
            profileId,
            status: "terminated",
            createdAt: header.createdAt ?? descriptor.createdAt,
            updatedAt: header.updatedAt ?? descriptor.updatedAt,
            cwd: header.cwd ?? descriptor.cwd,
            model: header.model ?? descriptor.model,
            sessionFile: workerFilePath
          };

          this.descriptors.set(workerId, workerDescriptor);
          knownWorkerIds.add(workerId);
          recoveredIds.push(workerId);
        } catch {
          // Skip unreadable worker files
        }
      }
    }

    if (recoveredIds.length > 0) {
      this.logDebug("boot:recover_missing_workers", {
        recoveredCount: recoveredIds.length,
        recoveredIds: recoveredIds.slice(0, 20),
        truncated: recoveredIds.length > 20
      });
    }
  }

  /**
   * Read the first few lines of a worker JSONL file to extract metadata.
   */
  private async readWorkerJSONLHeader(
    filePath: string
  ): Promise<{
    createdAt: string | null;
    updatedAt: string | null;
    cwd: string | null;
    model: AgentDescriptor["model"] | null;
  }> {
    // Only read first 4KB to parse header lines
    const headerChunk = await readFileHead(filePath, 4096);
    const lines = headerChunk.split("\n").filter((l) => l.trim());

    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let cwd: string | null = null;
    let model: AgentDescriptor["model"] | null = null;

    for (const line of lines.slice(0, 10)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        if (entry.type === "session") {
          createdAt = typeof entry.timestamp === "string" ? entry.timestamp : null;
          cwd = typeof entry.cwd === "string" ? entry.cwd : null;
        }

        if (entry.type === "model_change") {
          const provider = typeof entry.provider === "string" ? entry.provider : null;
          const modelId = typeof entry.modelId === "string" ? entry.modelId : null;
          if (provider && modelId) {
            model = { provider, modelId, thinkingLevel: "none" };
          }
          if (!updatedAt && typeof entry.timestamp === "string") {
            updatedAt = entry.timestamp;
          }
        }

        if (entry.type === "thinking_level_change" && model) {
          const thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
          if (thinkingLevel) {
            model = { ...model, thinkingLevel };
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return { createdAt, updatedAt: updatedAt ?? createdAt, cwd, model };
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = this.getConfiguredManagerId();

    for (const descriptor of this.sortedDescriptors()) {
      if (!this.shouldRestoreRuntimeForDescriptor(descriptor)) {
        continue;
      }

      try {
        await this.getOrCreateRuntimeForDescriptor(descriptor);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }

        const idleStatus = descriptor.status === "streaming"
          ? transitionAgentStatus(descriptor.status, "idle")
          : descriptor.status;
        descriptor.status = transitionAgentStatus(idleStatus, "stopped");
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    if (configuredManagerId) {
      const primaryManager = this.descriptors.get(configuredManagerId);
      if (
        primaryManager &&
        primaryManager.role === "manager" &&
        primaryManager.status === "streaming" &&
        !this.runtimes.has(configuredManagerId)
      ) {
        throw new Error("Primary manager runtime is not initialized");
      }
    }
  }

  private shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return this.lifecycleService.shouldRestoreRuntimeForDescriptor(descriptor);
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    return this.lifecycleService.getOrCreateRuntimeForDescriptor(descriptor);
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
        return configuredManager;
      }
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset);
  }

  private resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    return this.lifecycleService.resolveSpawnModelWithCapacityFallback(model);
  }

  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void {
    if (descriptor.role !== "worker") {
      return;
    }

    if (error.phase !== "prompt_dispatch" && error.phase !== "prompt_start") {
      return;
    }

    const classification = classifyRuntimeCapacityError(error.message);
    if (!classification.isQuotaOrRateLimit) {
      return;
    }

    const blockDurationMs = clampModelCapacityBlockDurationMs(
      classification.retryAfterMs ?? MODEL_CAPACITY_BLOCK_DEFAULT_MS
    );
    if (!blockDurationMs) {
      return;
    }

    const provider = normalizeOptionalAgentId(descriptor.model.provider)?.toLowerCase();
    const modelId = normalizeOptionalModelId(descriptor.model.modelId)?.toLowerCase();
    if (!provider || !modelId) {
      return;
    }

    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return;
    }

    const blockedUntilMs = Date.now() + blockDurationMs;
    const existing = this.modelCapacityBlocks.get(key);
    if (existing && existing.blockedUntilMs >= blockedUntilMs) {
      return;
    }

    this.modelCapacityBlocks.set(key, {
      provider,
      modelId,
      blockedUntilMs,
      blockSetAt: this.now(),
      sourcePhase: error.phase,
      reason: error.message
    });

    this.logDebug("model_capacity:block_set", {
      agentId,
      provider,
      modelId,
      phase: error.phase,
      retryAfterMs: classification.retryAfterMs,
      blockDurationMs,
      blockedUntil: new Date(blockedUntilMs).toISOString(),
      messagePreview: previewForLog(error.message, 240)
    });
  }

  private async resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string,
    profileId: string
  ): Promise<string | undefined> {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }

      const entry = await this.promptRegistry.resolveEntry("archetype", explicit, profileId);
      if (!entry) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }

      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private async loadSpecialistRegistryModule(): Promise<SpecialistRegistryModule> {
    if (!this.specialistRegistryModulePromise) {
      const dataDir = this.config.paths.dataDir;
      this.specialistRegistryModulePromise = Promise.resolve({
        resolveRoster: (profileId: string) =>
          specialistResolveRoster(profileId, dataDir) as Promise<ResolvedSpecialistDefinitionLike[]>,
        generateRosterBlock: specialistGenerateRosterBlock as (roster: ResolvedSpecialistDefinitionLike[]) => string,
        normalizeSpecialistHandle: specialistNormalizeSpecialistHandle,
        getSpecialistsEnabled: () => specialistGetSpecialistsEnabled(dataDir),
        legacyModelRoutingGuidance: LEGACY_MODEL_ROUTING_GUIDANCE,
      });
    }

    return this.specialistRegistryModulePromise!;
  }

  private async resolveSpecialistRosterForProfile(
    profileId: string
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    const specialistRegistry = await this.loadSpecialistRegistryModule();
    return specialistRegistry.resolveRoster(profileId);
  }

  async resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    return this.promptService.resolveProjectAgentSystemPromptOverride(descriptor, options);
  }

  private async buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<string> {
    return this.promptService.buildResolvedManagerPrompt(descriptor, options);
  }

  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    return this.promptService.resolveSystemPromptForDescriptor(descriptor);
  }

  private injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    return this.promptService.injectWorkerIdentityContext(descriptor, systemPrompt);
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId && base === configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${configuredManagerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(options?: { excludeCortex?: boolean }): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (options?.excludeCortex && normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID) {
        continue;
      }

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (normalizedExplicitTarget.channel === "telegram" && !normalizedExplicitTarget.channelId) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.resolvePreferredManagerId({ includeStoppedOnRestart: true });
      if (!managerId) {
        throw new Error("No manager is available.");
      }

      return {
        managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    await this.lifecycleService.terminateDescriptor(descriptor, options);
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    return this.promptService.getMemoryRuntimeResources(descriptor);
  }

  private async reloadSkillMetadata(): Promise<void> {
    await this.skillMetadataService.reloadSkillMetadata();
  }

  private async loadSecretsStore(): Promise<void> {
    await this.secretsEnvService.loadSecretsStore();
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.promptService.getSwarmContextFiles(cwd);
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeController.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
  }

  private async prepareManagerRuntimeCreation(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    systemPrompt: string
  ): Promise<{
    continuityRequest?: ModelChangeContinuityRequest;
    runtimeCreationOptions?: RuntimeCreationOptions;
  }> {
    const recovery = await resolvePendingModelChangeRuntimeStartup({
      descriptor,
      targetModel: descriptor.model,
      existingPrompt: systemPrompt,
      modelContextWindow: modelCatalogService.getEffectiveContextWindow(
        descriptor.model.modelId,
        descriptor.model.provider
      ),
      hasPinnedContent: this.pinnedMessageIdsBySessionAgentId.has(descriptor.agentId)
    });

    if (!recovery.request) {
      return {};
    }

    this.logDebug("manager:model_change_continuity:prepare", {
      agentId: descriptor.agentId,
      requestId: recovery.request.requestId,
      sourceModel: recovery.request.sourceModel,
      targetModel: recovery.request.targetModel,
      policy: recovery.policy,
      eligibleEntryCount: recovery.recoveryContext?.eligibleEntryCount,
      includedEntryCount: recovery.recoveryContext?.includedEntryCount,
      omittedEntryCount: recovery.recoveryContext?.omittedEntryCount,
      truncated: recovery.recoveryContext?.truncated,
      approxTokenCount: recovery.recoveryContext?.approxTokenCount
    });

    return {
      continuityRequest: recovery.request,
      runtimeCreationOptions: recovery.policy === "skip_pi_to_pi"
        ? undefined
        : {
            startupRecoveryContext: {
              reason: "model_change",
              blockText: recovery.recoveryContext?.blockText ?? ""
            }
          }
    };
  }

  private async appendAppliedModelChangeContinuity(
    descriptor: AgentDescriptor & { role: "manager"; profileId: string },
    request: ModelChangeContinuityRequest,
    runtime: SwarmAgentRuntime
  ): Promise<void> {
    await appendModelChangeContinuityApplied({
      sessionFile: descriptor.sessionFile,
      cwd: descriptor.cwd,
      applied: createModelChangeContinuityApplied({
        requestId: request.requestId,
        appliedAt: this.now(),
        sessionAgentId: descriptor.agentId,
        attachedRuntime: runtime.descriptor.model
      }),
      now: this.now
    });
  }

  private allocateRuntimeToken(agentId: string): number {
    return this.runtimeController.allocateRuntimeToken(agentId);
  }

  private clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    this.runtimeController.clearRuntimeToken(agentId, runtimeToken);
  }

  private detachRuntime(agentId: string, runtimeToken?: number): boolean {
    return this.runtimeController.detachRuntime(agentId, runtimeToken);
  }

  private async runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    return this.runtimeController.runRuntimeShutdown(descriptor, action, options);
  }

  private async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    await this.runtimeController.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
  }

  async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent
  ): Promise<void> {
    await this.runtimeController.handleRuntimeSessionEvent(runtimeTokenOrAgentId, agentIdOrEvent, maybeEvent);
  }

  async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent
  ): Promise<void> {
    await this.runtimeController.handleRuntimeError(runtimeTokenOrAgentId, agentIdOrError, maybeError);
  }

  private async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    await this.runtimeController.handleRuntimeAgentEnd(runtimeTokenOrAgentId, maybeAgentId);
  }

  async queueVersionedToolMutation(
    descriptor: AgentDescriptor,
    mutation: VersioningMutation
  ): Promise<void> {
    this.queueVersioningMutation({
      ...mutation,
      reviewRunId: await this.resolveActiveCortexReviewRunIdForDescriptor(descriptor)
    });
  }

  private async resolveActiveCortexReviewRunIdForDescriptor(descriptor: AgentDescriptor): Promise<string | undefined> {
    return this.cortexService.resolveActiveReviewRunIdForDescriptor(descriptor);
  }

  private queueVersioningMutation(mutation: VersioningMutation): void {
    void this.versioningService?.recordMutation(mutation).catch((error) => {
      this.logDebug("versioning:record_error", {
        path: mutation.path,
        source: mutation.source,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    const descriptor = this.descriptors.get(agentId);
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? descriptor?.contextUsage);
    const runtime = this.runtimes.get(agentId);
    const contextRecoveryInProgress = runtime?.isContextRecoveryInProgress?.() === true;
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      ...(descriptor?.role === "worker" ? { managerId: descriptor.managerId } : {}),
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {}),
      ...(contextRecoveryInProgress ? { contextRecoveryInProgress } : {}),
      ...(descriptor?.streamingStartedAt != null ? { streamingStartedAt: descriptor.streamingStartedAt } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);

    this.cortexService.handleAgentStatusEvent(descriptor, status);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listManagerAgents()
    };

    this.emit("agents_snapshot", payload satisfies ServerEvent);
  }

  private emitProfilesSnapshot(): void {
    this.emit(
      "profiles_snapshot",
      {
        type: "profiles_snapshot",
        profiles: this.listProfiles()
      } satisfies ServerEvent
    );
  }

  private emitSessionProjectAgentUpdated(
    agentId: string,
    profileId: string,
    projectAgent: AgentDescriptor["projectAgent"] | null
  ): void {
    this.emit(
      "session_project_agent_updated",
      {
        type: "session_project_agent_updated",
        agentId,
        profileId,
        projectAgent: cloneProjectAgentInfoValue(projectAgent) ?? null
      } satisfies ServerEvent
    );
  }

  private emitSessionLifecycle(event: SessionLifecycleEvent): void {
    this.emit("session_lifecycle", event);
  }

  private async rebuildSessionManifestForBoot(): Promise<void> {
    await this.sessionMetaService.rebuildSessionManifestForBoot();
  }

  private async hydrateCompactionCountsForBoot(): Promise<void> {
    await this.sessionMetaService.hydrateCompactionCountsForBoot();
  }

  private startCompactionCountBackfill(): void {
    this.sessionMetaService.startCompactionCountBackfill();
  }

  private async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    await this.sessionMetaService.writeInitialSessionMeta(descriptor);
  }

  private async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    await this.sessionMetaService.captureSessionRuntimePromptMeta(descriptor, resolvedSystemPrompt);
  }

  private async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    await this.sessionMetaService.updateSessionMetaForWorkerDescriptor(descriptor, resolvedSystemPrompt);
  }

  private async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.sessionMetaService.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  private async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.sessionMetaService.refreshSessionMetaStatsBySessionId(sessionAgentId, sessionFileOverride);
  }

  private async incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined> {
    return this.sessionMetaService.incrementSessionCompactionCount(profileId, sessionId, failureLogKey);
  }

  private async readSessionMetaForDescriptor(descriptor: AgentDescriptor): Promise<SessionMeta | undefined> {
    return this.sessionMetaService.readSessionMetaForDescriptor(descriptor);
  }

  private isRuntimeInContextRecovery(agentId: string): boolean {
    const runtime = this.runtimes.get(agentId);
    return Boolean(runtime?.isContextRecoveryInProgress?.());
  }

  private markPendingManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNotice(agentId);

    const timer = setTimeout(() => {
      this.pendingManualManagerStopNoticeTimersByAgentId.delete(agentId);
    }, PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS);
    timer.unref?.();

    this.pendingManualManagerStopNoticeTimersByAgentId.set(agentId, timer);
  }

  private clearPendingManualManagerStopNotice(agentId: string): void {
    const timer = this.pendingManualManagerStopNoticeTimersByAgentId.get(agentId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingManualManagerStopNoticeTimersByAgentId.delete(agentId);
  }

  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean {
    if (!this.pendingManualManagerStopNoticeTimersByAgentId.has(agentId) || event.type !== "message_end") {
      return false;
    }

    if (extractRole(event.message) !== "assistant") {
      return false;
    }

    const stopReason = extractMessageStopReason(event.message);
    const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
    if (stopReason !== "error" && !hasStructuredErrorMessage) {
      return false;
    }

    const normalizedErrorMessage = normalizeProviderErrorMessage(
      extractMessageErrorMessage(event.message) ?? extractMessageText(event.message)
    );

    this.clearPendingManualManagerStopNotice(agentId);
    return isAbortLikeErrorMessage(normalizedErrorMessage);
  }

  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent {
    if (event.type !== "message_end") {
      return event;
    }

    const messageWithMetadata = event.message as typeof event.message & { errorMessage?: unknown; stopReason?: unknown };
    const { errorMessage: _errorMessage, ...messageWithoutError } = messageWithMetadata;

    return {
      ...event,
      message: {
        ...messageWithoutError,
        stopReason: "stop"
      } as typeof event.message
    };
  }

  async checkForStalledWorkers(): Promise<void> {
    return this.workerHealthService.checkForStalledWorkers();
  }

  async handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallNudge(agentId, elapsedMs);
  }

  async handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallDetailedReport(agentId, elapsedMs);
  }

  async handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    await this.workerHealthService.handleStallAutoKill(agentId, elapsedMs);
  }

  async finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void> {
    await this.workerHealthService.finalizeWorkerIdleTurn(agentId, descriptor, source);
  }

  private seedWorkerCompletionReportTimestamp(agentId: string): void {
    this.workerHealthService.seedWorkerCompletionReportTimestamp(agentId);
  }

  getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogState {
    return this.workerHealthService.getOrCreateWorkerWatchdogState(agentId);
  }

  clearWatchdogTimer(agentId: string): void {
    this.workerHealthService.clearWatchdogTimer(agentId);
  }

  private clearWatchdogState(agentId: string): void {
    this.workerHealthService.clearWatchdogState(agentId);
  }

  removeWorkerFromWatchdogBatchQueues(agentId: string): void {
    this.workerHealthService.removeWorkerFromWatchdogBatchQueues(agentId);
  }

  get workerWatchdogState(): Map<string, WorkerWatchdogState> {
    return this.workerHealthService.workerWatchdogState;
  }

  get workerStallState(): Map<string, WorkerStallState> {
    return this.workerHealthService.workerStallState;
  }

  get workerActivityState(): Map<string, WorkerActivityState> {
    return this.workerHealthService.workerActivityState;
  }

  get watchdogTimers(): Map<string, NodeJS.Timeout> {
    return this.workerHealthService.watchdogTimers;
  }

  get watchdogTimerTokens(): Map<string, number> {
    return this.workerHealthService.watchdogTimerTokens;
  }

  get watchdogBatchQueueByManager(): Map<string, Map<string, WatchdogBatchEntry>> {
    return this.workerHealthService.watchdogBatchQueueByManager;
  }

  get watchdogBatchTimersByManager(): Map<string, NodeJS.Timeout> {
    return this.workerHealthService.watchdogBatchTimersByManager;
  }

  private async ensureDirectories(): Promise<void> {
    await this.persistenceService.ensureDirectories();
  }

  private getPiModelsJsonPathOrThrow(): string {
    if (!this.piModelsJsonPath) {
      throw new Error("Pi model projection path is unavailable before SwarmManager boot completes.");
    }

    return this.piModelsJsonPath;
  }

  private async refreshPiModelsJsonProjection(): Promise<void> {
    this.piModelsJsonPath = await generatePiProjection(this.config.paths.dataDir);
    this.logDebug("model_catalog:projection:generated", {
      path: this.piModelsJsonPath,
    });
  }

  private async ensureSessionFileParentDirectory(sessionFile: string): Promise<void> {
    await mkdir(dirname(sessionFile), { recursive: true });
  }

  private getAgentMemoryPath(agentId: string): string {
    const descriptor = this.descriptors.get(agentId);

    if (!descriptor) {
      const fallbackAgentId = normalizeOptionalAgentId(agentId) ?? agentId;
      return resolveMemoryFilePath(this.config.paths.dataDir, {
        agentId: fallbackAgentId,
        role: "manager",
        profileId: fallbackAgentId,
        managerId: fallbackAgentId
      });
    }

    const parentDescriptor = descriptor.role === "worker"
      ? this.descriptors.get(descriptor.managerId)
      : undefined;

    const parentProfileId =
      descriptor.role === "worker"
        ? normalizeOptionalAgentId(parentDescriptor?.profileId ?? descriptor.profileId)
        : undefined;

    return resolveMemoryFilePath(
      this.config.paths.dataDir,
      {
        agentId: descriptor.agentId,
        role: descriptor.role,
        profileId: descriptor.profileId,
        managerId: descriptor.managerId
      },
      parentProfileId ? { profileId: parentProfileId } : undefined
    );
  }

  private resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (managerId) {
      return managerId;
    }

    return this.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ?? descriptor.agentId;
  }

  private resolveSessionProfileId(memoryOwnerAgentId: string): string | undefined {
    const memoryOwnerDescriptor = this.descriptors.get(memoryOwnerAgentId);
    if (!memoryOwnerDescriptor || memoryOwnerDescriptor.role !== "manager") {
      return undefined;
    }

    return normalizeOptionalAgentId(memoryOwnerDescriptor.profileId) ?? memoryOwnerDescriptor.agentId;
  }

  protected async executeProjectAgentAnalysis(
    model: Model<Api>,
    options: AnalyzeSessionForPromotionOptions
  ): Promise<ProjectAgentRecommendations> {
    return analyzeSessionForPromotion(model, options);
  }

  private async resolveProjectAgentAnalysisModel(): Promise<{
    model: Model<Api>;
    apiKey?: string;
    headers?: Record<string, string>;
    modelLabel: string;
  }> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.config);
    const authStorage = AuthStorage.create(authFilePath);
    const piModelsJsonPath = this.getPiModelsJsonPathOrThrow();
    const modelRegistry = createPiModelRegistry(authStorage, piModelsJsonPath);

    const candidates = [
      { provider: "anthropic", modelId: "claude-opus-4-6" },
      { provider: "openai-codex", modelId: "gpt-5.4" }
    ] as const;
    const failureMessages: string[] = [];

    for (const candidate of candidates) {
      const model =
        modelRegistry.find(candidate.provider, candidate.modelId) ??
        (getModel(candidate.provider as never, candidate.modelId as never) as Model<Api> | undefined);
      if (!model) {
        failureMessages.push(`Model ${candidate.provider}/${candidate.modelId} is unavailable.`);
        continue;
      }

      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        failureMessages.push(`${candidate.provider}/${candidate.modelId}: ${auth.error}`);
        continue;
      }

      return {
        model,
        apiKey: auth.apiKey,
        headers: auth.headers,
        modelLabel: `${candidate.provider}/${candidate.modelId}`
      };
    }

    throw new Error(
      [
        "No configured model is available for project agent analysis.",
        "Tried anthropic/claude-opus-4-6 first, then openai-codex/gpt-5.4.",
        failureMessages.join(" ")
      ]
        .filter((part) => part.trim().length > 0)
        .join(" ")
    );
  }

  protected async executeSessionMemoryLLMMerge(
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ): Promise<{ mergedContent: string; model: string }> {
    return this.memoryMergeService.executeSessionMemoryLLMMerge(
      descriptor,
      profileMemoryContent,
      sessionMemoryContent
    );
  }

  private async writeSessionMemoryMergeAttemptMeta(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate
  ): Promise<void> {
    await this.sessionMetaService.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  private async recordSessionMemoryMergeAttempt(
    descriptor: AgentDescriptor,
    attempt: {
      attemptId?: string | null;
      timestamp: string;
      status: SessionMemoryMergeAttemptStatus;
      strategy?: SessionMemoryMergeStrategy | null;
      failureStage?: SessionMemoryMergeFailureStage | null;
      sessionContentHash?: string | null;
      profileContentHashBefore?: string | null;
      profileContentHashAfter?: string | null;
      appliedSourceHash?: string | null;
      error?: string;
    }
  ): Promise<void> {
    await this.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  private async appendSessionMemoryMergeAuditEntry(entry: SessionMemoryMergeAuditEntry): Promise<void> {
    await appendFile(
      getProfileMergeAuditLogPath(this.config.paths.dataDir, entry.profileId),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  }

  private async refreshDefaultMemoryTemplateNormalizedLines(): Promise<void> {
    await this.memoryMergeService.refreshDefaultMemoryTemplateNormalizedLines();
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    await this.memoryMergeService.ensureMemoryFilesForBoot();
  }

  private async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    await this.memoryMergeService.ensureAgentMemoryFile(memoryFilePath, profileId);
  }

  private async ensureProfilePiDirectories(profileId: string): Promise<void> {
    await this.persistenceService.ensureProfilePiDirectories(profileId);
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    await this.persistenceService.deleteManagerSessionFile(sessionFile);
  }

  private async deleteManagerSchedulesFile(profileId: string): Promise<void> {
    await this.persistenceService.deleteManagerSchedulesFile(profileId);
  }

  private async loadStore(): Promise<AgentsStoreFile> {
    return this.persistenceService.loadStore();
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationProjector.loadConversationHistoriesFromStore();
  }

  private async saveStore(): Promise<void> {
    await this.persistenceService.saveStore();
  }
}

function isSessionRenameHistoryEntry(value: unknown): value is SessionRenameHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    typeof value.renamedAt === "string"
  );
}


import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getModel, type Api, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type {
  AgentRuntimeExtensionSnapshot,
  ChoiceRequestEvent,
  CredentialPoolState,
  CredentialPoolStrategy,
  PooledCredentialInfo,
  CortexReviewRunRecord,
  CortexReviewRunScope,
  CortexReviewRunTrigger,
  OnboardingState,
  PersistedProjectAgentConfig,
  ServerEvent,
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
  SessionMeta
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
  getProjectAgentPromptPath,
  getSessionDir,
  getSessionFilePath,
  getSessionMetaPath,
  getWorkerSessionFilePath,
  getWorkersDir,
  resolveMemoryFilePath,
  sanitizePathSegment as sanitizePersistedPathSegment
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
import type { CredentialPoolService } from "./credential-pool.js";
import { migrateDataDirectory } from "./data-migration.js";
import { cleanupOldSharedConfigPaths, migrateSharedConfigLayout } from "./shared-config-migration.js";
import {
  appendCortexReviewRun,
  buildCortexReviewRunRequestText,
  buildCortexReviewRunScopeLabel,
  buildLiveCortexReviewRunRecord,
  createCortexReviewRunId,
  deriveLiveStatus,
  parseCortexReviewRunScopeFromText,
  parseScheduledTaskEnvelope,
  readStoredCortexReviewRuns,
  type StoredCortexReviewRun
} from "./cortex-review-runs.js";
import { executeLLMMerge, MEMORY_MERGE_SYSTEM_PROMPT } from "./memory-merge.js";
import {
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext
} from "./agent-creator-context.js";
import {
  analyzeSessionForPromotion,
  type AnalyzeSessionForPromotionOptions,
  type ProjectAgentRecommendations
} from "./project-agent-analysis.js";
import {
  deleteProjectAgentRecord,
  readProjectAgentRecord,
  reconcileProjectAgentStorage,
  renameProjectAgentRecord,
  writeProjectAgentRecord
} from "./project-agent-storage.js";
import {
  deliverProjectAgentMessage,
  findProjectAgentByHandle,
  formatProjectAgentRuntimeMessage,
  generateProjectAgentDirectoryBlock,
  getProjectAgentHandleCollisionError,
  getProjectAgentPublicName,
  listProjectAgents,
  normalizeProjectAgentHandle,
  normalizeProjectAgentInlineText
} from "./project-agents.js";
import { PersistenceService } from "./persistence-service.js";
import { ForgeExtensionHost } from "./forge-extension-host.js";
import type { VersioningCommitEvent as ForgeVersioningCommitEvent } from "./forge-extension-types.js";
import { createForgeBindingToken } from "./forge-extension-types.js";
import {
  deleteProjectAgentReferenceDoc,
  listProjectAgentReferenceDocs,
  migrateLegacyProfileKnowledgeToReferenceDoc,
  readProjectAgentReferenceDoc,
  writeProjectAgentReferenceDoc
} from "./reference-docs.js";
import { scanCortexReviewStatus } from "./scripts/cortex-scan.js";
import { generatePiProjection } from "./model-catalog-projection.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { CLAUDE_RUNTIME_STATE_ENTRY_TYPE } from "./claude-agent-runtime.js";
import { RuntimeFactory } from "./runtime-factory.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import {
  computePromptFingerprint,
  backfillCompactionCounts,
  incrementSessionCompactionCount,
  readSessionMeta,
  rebuildSessionMeta,
  updateSessionMetaStats,
  updateSessionMetaWorker,
  writeSessionMeta
} from "./session-manifest.js";
import { SecretsEnvService } from "./secrets-env-service.js";
import { SkillFileService } from "./skill-file-service.js";
import { SkillMetadataService } from "./skill-metadata-service.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
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
  inferProviderFromModelId,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  parseSwarmModelPreset,
  parseSwarmReasoningLevel,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import { getOnboardingSnapshot, loadOnboardingState } from "./onboarding-state.js";
import {
  generateRosterBlock as specialistGenerateRosterBlock,
  getSpecialistsEnabled as specialistGetSpecialistsEnabled,
  LEGACY_MODEL_ROUTING_GUIDANCE,
  normalizeSpecialistHandle as specialistNormalizeSpecialistHandle,
  resolveRoster as specialistResolveRoster,
} from "./specialists/specialist-registry.js";
import {
  isNonRunningAgentStatus,
  normalizeAgentStatus,
  transitionAgentStatus,
  type AgentStatusInput
} from "./agent-state-machine.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  SetPinnedContentOptions,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime
} from "./runtime-types.js";
import type { SwarmToolHost } from "./swarm-tools.js";
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
  ConversationAttachmentMetadata,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
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


const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const CORTEX_DISPLAY_NAME = "Cortex";
const CORTEX_REVIEW_RUN_QUEUE_RETRY_MS = 250;
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
const COMMON_KNOWLEDGE_MEMORY_HEADER =
  "# Common Knowledge (maintained by Cortex — read-only reference)";
const ONBOARDING_SNAPSHOT_MEMORY_HEADER =
  "# Onboarding Snapshot (authoritative backend state — read-only reference)";
const COMMON_KNOWLEDGE_INITIAL_TEMPLATE = `# Common Knowledge
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Interaction Defaults

## Workflow Defaults

## Cross-Project Technical Standards

## Cross-Project Gotchas
`;

/* eslint-disable no-useless-escape */
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
/* eslint-enable no-useless-escape */

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
  '> Forked from session "${SOURCE_LABEL}" (${SOURCE_AGENT_ID}) on ${FORK_TIMESTAMP}',
  "> ${FORK_HISTORY_NOTE}",
  ""
].join("\n");

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;
const CORTEX_USER_CLOSEOUT_REMINDER_MESSAGE = `SYSTEM: Before ending this direct review, publish a concise speak_to_user closeout. State the reviewed scope, whether anything was promoted, which files changed (or NONE), and whether follow-up remains. Report changed files as paths relative to the active data dir only — never absolute host paths. If exact files are uncertain, prefer NONE over guessing. Do this even for a no-op review.`;

// Retain recent non-web activity while preserving the full user-facing web transcript.
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";
// Integration services add ~2 event listeners per profile (Telegram conversation_message,
// Telegram session_lifecycle). Keep this limit above base listeners +
// (2 × expected maximum profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const IDLE_WORKER_WATCHDOG_GRACE_MS = 3_000;
const WATCHDOG_BATCH_WINDOW_MS = 750;
const WATCHDOG_BATCH_PREVIEW_LIMIT = 10;
const WATCHDOG_BACKOFF_BASE_MS = 15_000;
const WATCHDOG_BACKOFF_MAX_MS = 5 * 60_000;
const WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS = 3;
const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_NUDGE_THRESHOLD_MS = 5 * 60_000;
const STALL_DETAILED_REPORT_INTERVAL_MS = 10 * 60_000;
const STALL_KILL_AFTER_NUDGE_MS = 25 * 60_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;
const PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS = 15_000;
const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";
const MODEL_CAPACITY_BLOCK_DEFAULT_MS = 10 * 60_000;
const MODEL_CAPACITY_BLOCK_MIN_MS = 5_000;
const MODEL_CAPACITY_BLOCK_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
const OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN = ["gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-5.4"];
const MAX_WORKER_COMPLETION_REPORT_CHARS = 4_000;
const WORKER_COMPLETION_TRUNCATION_SUFFIX = "\n\n[truncated]";
const SESSION_ID_SUFFIX_SEPARATOR = "--s";
const ROOT_SESSION_NUMBER = 1;
const DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT = [
  "# Swarm Memory",
  "",
  "## User Preferences",
  "- (none yet)",
  "",
  "## Project Facts",
  "- (none yet)",
  "",
  "## Decisions",
  "- (none yet)",
  "",
  "## Open Follow-ups",
  "- (none yet)",
  ""
].join("\n");

const DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES = normalizeMemoryTemplateLines(
  DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
);

interface SessionMemoryMergeAuditEntry {
  attemptId: string;
  timestamp: string;
  sessionAgentId: string;
  profileId: string;
  status: SessionMemoryMergeAttemptStatus;
  strategy: SessionMemoryMergeStrategy;
  stage?: SessionMemoryMergeFailureStage;
  llmMergeSucceeded: boolean;
  usedFallbackAppend: boolean;
  appliedChange: boolean;
  model: string;
  sessionContentHash: string;
  profileContentHashBefore: string;
  profileContentHashAfter?: string;
  error?: string;
}

interface SessionMemoryMergeFailureContext {
  timestamp: string;
  attemptId: string;
  profileId: string;
  auditPath: string;
  stage: SessionMemoryMergeFailureStage;
  strategy?: SessionMemoryMergeStrategy;
  sessionContentHash?: string;
  profileContentHashBefore: string;
  profileContentHashAfter?: string;
  llmMergeSucceeded: boolean;
  model: string;
  appliedChange: boolean;
}

class SessionMemoryMergeFailure extends Error {
  readonly strategy?: SessionMemoryMergeStrategy;
  readonly stage: SessionMemoryMergeFailureStage;
  readonly auditPath: string;

  constructor(message: string, options: {
    strategy?: SessionMemoryMergeStrategy;
    stage: SessionMemoryMergeFailureStage;
    auditPath: string;
  }) {
    super(message);
    this.name = "SessionMemoryMergeFailure";
    this.strategy = options.strategy;
    this.stage = options.stage;
    this.auditPath = options.auditPath;
  }
}

export class ChoiceRequestCancelledError extends Error {
  constructor(public readonly reason: "cancelled" | "expired") {
    super(`Choice request ${reason}`);
    this.name = "ChoiceRequestCancelledError";
  }
}

interface SessionRenameHistoryEntry {
  from: string;
  to: string;
  renamedAt: string;
}

interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
  pendingReportTurnSeq: number | null;
  deferredFinalizeTurnSeq: number | null;
  hadStreamingThisTurn: boolean;
  lastFinalizedTurnSeq: number | null;
  consecutiveNotifications: number;
  suppressedUntilMs: number;
  circuitOpen: boolean;
}

interface WatchdogBatchEntry {
  workerId: string;
  turnSeq: number;
}

interface WorkerStallState {
  lastProgressAt: number;
  nudgeSent: boolean;
  nudgeSentAt: number | null;
  lastToolName: string | null;
  lastToolInput: string | null;
  lastToolOutput: string | null;
  lastDetailedReportAt: number | null;
}

interface WorkerActivityState {
  currentToolName: string | null;
  currentToolStartedAt: number | null;
  lastProgressAt: number;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
}

interface SpecialistFallbackHandoffState {
  suppressedRuntimeToken: number;
  startedAt: string;
  bufferedStatus?: {
    status: AgentStatus;
    pendingCount: number;
    contextUsage?: AgentContextUsage;
  };
  receivedAgentEnd?: boolean;
}

interface PromptPreviewSection {
  label: string;
  content: string;
  source: string;
}

interface ModelCapacityBlock {
  provider: string;
  modelId: string;
  blockedUntilMs: number;
  blockSetAt: string;
  sourcePhase: RuntimeErrorEvent["phase"];
  reason: string;
}

function hasOnboardingPreferenceValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function shouldInjectOnboardingSnapshot(snapshot: OnboardingState): boolean {
  return (
    snapshot.status === "completed" &&
    (
      hasOnboardingPreferenceValue(snapshot.preferences?.preferredName) ||
      snapshot.preferences?.technicalLevel !== null ||
      hasOnboardingPreferenceValue(snapshot.preferences?.additionalPreferences)
    )
  );
}

function humanizeOnboardingTechnicalLevel(value: NonNullable<NonNullable<OnboardingState["preferences"]>["technicalLevel"]>): string {
  switch (value) {
    case "developer":
      return "developer";
    case "technical_non_developer":
      return "technical (non-developer)";
    case "semi_technical":
      return "semi-technical";
    case "non_technical":
      return "non-technical";
    default:
      return value;
  }
}

function buildOnboardingSnapshotMemoryBlock(snapshot: OnboardingState): string {
  const lines = [ONBOARDING_SNAPSHOT_MEMORY_HEADER, "", `- status: ${snapshot.status}`];

  if (snapshot.preferences?.preferredName) {
    lines.push(`- preferred name: ${snapshot.preferences.preferredName}`);
  }

  if (snapshot.preferences?.technicalLevel) {
    lines.push(`- technical level: ${humanizeOnboardingTechnicalLevel(snapshot.preferences.technicalLevel)}`);
  }

  if (snapshot.preferences?.additionalPreferences) {
    lines.push(`- additional preferences: ${snapshot.preferences.additionalPreferences.replace(/\s+/g, " ").trim()}`);
  }

  return `${lines.join("\n")}\n`;
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

function cloneContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent
  };
}

function cloneProjectAgentInfoValue(
  projectAgent: AgentDescriptor["projectAgent"] | null | undefined
): AgentDescriptor["projectAgent"] | null | undefined {
  if (!projectAgent) {
    return projectAgent;
  }

  return {
    handle: projectAgent.handle,
    whenToUse: projectAgent.whenToUse,
    // systemPrompt intentionally omitted — fetched via get_project_agent_config
    ...(projectAgent.creatorSessionId !== undefined
      ? { creatorSessionId: projectAgent.creatorSessionId }
      : {})
  };
}

function cloneProjectAgentInfo(descriptor: AgentDescriptor): AgentDescriptor["projectAgent"] {
  return cloneProjectAgentInfoValue(descriptor.projectAgent) ?? undefined;
}

function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: cloneContextUsage(descriptor.contextUsage),
    projectAgent: cloneProjectAgentInfo(descriptor),
    ...(descriptor.agentCreatorResult !== undefined
      ? {
          agentCreatorResult: {
            createdAgentId: descriptor.agentCreatorResult.createdAgentId,
            createdHandle: descriptor.agentCreatorResult.createdHandle,
            createdAt: descriptor.agentCreatorResult.createdAt
          }
        }
      : {})
  };
}

function normalizeContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  if (
    typeof contextUsage.tokens !== "number" ||
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0
  ) {
    return undefined;
  }

  if (
    typeof contextUsage.contextWindow !== "number" ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (typeof contextUsage.percent !== "number" || !Number.isFinite(contextUsage.percent)) {
    return undefined;
  }

  return {
    tokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
    percent: Math.max(0, Math.min(100, contextUsage.percent))
  };
}

function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly profiles = new Map<string, ManagerProfile>();
  private readonly profileMergeMutexes = new Map<string, Promise<void>>();
  private cortexReviewRunStartMutex: Promise<void> = Promise.resolve();
  private cortexReviewRunQueueTimer: NodeJS.Timeout | null = null;
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
  private readonly runtimeTokensByAgentId = new Map<string, number>();
  private readonly specialistFallbackHandoffsByAgentId = new Map<string, SpecialistFallbackHandoffState>();
  private readonly runtimeExtensionSnapshotsByAgentId = new Map<string, AgentRuntimeExtensionSnapshot>();
  private nextRuntimeToken = 1;
  private readonly pendingManagerRuntimeRecycleAgentIds = new Set<string>();
  private readonly projectAgentMessageTimestampsBySender = new Map<string, number[]>();
  private readonly pendingManualManagerStopNoticeTimersByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly pendingChoiceRequests = new Map<string, {
    choiceId: string;
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
    resolve: (answers: ChoiceAnswer[]) => void;
    reject: (reason: Error) => void;
    createdAt: string;
  }>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly pinnedMessageIdsBySessionAgentId = new Map<string, Set<string>>();
  private readonly workerWatchdogState = new Map<string, WorkerWatchdogState>();
  private readonly workerStallState = new Map<string, WorkerStallState>();
  private readonly workerActivityState = new Map<string, WorkerActivityState>();
  private readonly watchdogTimers = new Map<string, NodeJS.Timeout>();
  private stallCheckInterval: NodeJS.Timeout | null = null;
  private stallCheckPromise: Promise<void> | null = null;
  private readonly watchdogTimerTokens = new Map<string, number>();
  private readonly watchdogBatchQueueByManager = new Map<string, Map<string, WatchdogBatchEntry>>();
  private readonly watchdogBatchTimersByManager = new Map<string, NodeJS.Timeout>();
  private readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  private readonly lastWorkerCompletionReportTimestampByAgentId = new Map<string, number>();
  private readonly lastWorkerCompletionReportSummaryKeyByAgentId = new Map<string, string>();
  private readonly lastCortexCloseoutReminderUserTimestampByAgentId = new Map<string, number>();
  private readonly cortexCloseoutReminderTimersByAgentId = new Map<string, NodeJS.Timeout>();
  private readonly conversationProjector: ConversationProjector;
  private readonly persistenceService: PersistenceService;
  private readonly forgeExtensionHost: ForgeExtensionHost;
  private readonly runtimeFactory: RuntimeFactory;
  private piModelsJsonPath: string | null = null;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly skillFileService: SkillFileService;
  private readonly secretsEnvService: SecretsEnvService;
  readonly promptRegistry: PromptRegistry;

  private defaultMemoryTemplateNormalizedLines = DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES;
  private integrationContextProvider: ((profileId: string) => string) | undefined;
  private readonly versioningService: VersioningMutationSink | undefined;
  private readonly trackedToolPathsByAgentId = new Map<string, Map<string, { toolName: string; path: string }>>();
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
    this.forgeExtensionHost = new ForgeExtensionHost({
      dataDir: this.config.paths.dataDir,
      now: this.now
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
    this.runtimeFactory = new RuntimeFactory({
      host: this,
      forgeExtensionHost: this.forgeExtensionHost,
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getPiModelsJsonPath: () => this.getPiModelsJsonPathOrThrow(),
      getCredentialPoolService: () => this.secretsEnvService.getCredentialPoolService(),
      onSessionFileRotated: async (descriptor, sessionFile) => {
        if (descriptor.role !== "manager") {
          await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
          return;
        }

        await this.refreshSessionMetaStats(descriptor, sessionFile);
      },
      getMemoryRuntimeResources: async (descriptor) => this.getMemoryRuntimeResources(descriptor),
      getSwarmContextFiles: async (cwd) => this.getSwarmContextFiles(cwd),
      mergeRuntimeContextFiles: (baseAgentsFiles, options) =>
        this.mergeRuntimeContextFiles(baseAgentsFiles, options),
      callbacks: {
        onStatusChange: async (runtimeToken, agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (runtimeToken, agentId, event) => {
          await this.handleRuntimeSessionEvent(runtimeToken, agentId, event);
        },
        onAgentEnd: async (runtimeToken, agentId) => {
          await this.handleRuntimeAgentEnd(runtimeToken, agentId);
        },
        onRuntimeError: async (runtimeToken, agentId, error) => {
          await this.handleRuntimeError(runtimeToken, agentId, error);
        },
        onRuntimeExtensionSnapshot: async (runtimeToken, agentId, snapshot) => {
          this.handleRuntimeExtensionSnapshot(runtimeToken, agentId, snapshot);
        }
      }
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
    await this.reconcileInterruptedCortexReviewRunsForBoot();
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

    // Fire-and-forget: one-time backfill of historical compaction counts from JSONL
    void backfillCompactionCounts(this.config.paths.dataDir).then((result) => {
      // Update in-memory descriptors with backfilled counts
      for (const [sessionId, count] of result.counts) {
        const descriptor = this.descriptors.get(sessionId);
        if (descriptor && descriptor.role === "manager") {
          descriptor.compactionCount = count;
        }
      }
      if (result.counts.size > 0) {
        this.emitAgentsSnapshot();
      }
      this.logDebug("boot:compaction-count-backfill:done", { sessionsUpdated: result.counts.size });
    }).catch((err) => {
      this.logDebug("boot:compaction-count-backfill:error", { error: String(err) });
    });

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
    this.scheduleCortexReviewRunQueueCheck(0);

    if (!this.stallCheckInterval) {
      this.stallCheckInterval = setInterval(() => {
        void this.checkForStalledWorkers().catch((error) => {
          this.logDebug("stall:check:error", {
            message: error instanceof Error ? error.message : String(error)
          });
        });
      }, STALL_CHECK_INTERVAL_MS);
      this.stallCheckInterval.unref();
    }

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

  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined {
    const state = this.workerActivityState.get(agentId);
    if (!state) {
      return undefined;
    }

    const now = Date.now();
    const currentToolElapsedSec = state.currentToolStartedAt !== null
      ? Math.round((now - state.currentToolStartedAt) / 1000)
      : 0;
    const idleSec = state.currentToolName !== null
      ? 0
      : Math.round((now - state.lastProgressAt) / 1000);

    return {
      currentTool: state.currentToolName,
      currentToolElapsedSec,
      toolCalls: state.toolCallCount,
      errors: state.errorCount,
      turns: state.turnCount,
      idleSec
    };
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

  private async reconcileInterruptedCortexReviewRunsForBoot(): Promise<void> {
    if (!this.config.cortexEnabled) {
      return;
    }

    const storedRuns = await readStoredCortexReviewRuns(this.config.paths.dataDir);
    const interruptedRuns = storedRuns
      .slice()
      .reverse()
      .filter((stored) => {
        if (!stored.sessionAgentId) {
          return false;
        }

        const sessionDescriptor = this.descriptors.get(stored.sessionAgentId);
        const activeWorkerCount = this.getWorkersForManager(stored.sessionAgentId)
          .filter((worker) => worker.status === "streaming")
          .length;

        return deriveLiveStatus(stored, sessionDescriptor, activeWorkerCount) === "running";
      });

    if (interruptedRuns.length === 0) {
      return;
    }

    const reconciledAt = this.now();
    const interruptionReason = "Interrupted by backend restart; request requeued automatically.";
    const reconciledPairs: Array<{ interruptedRunId: string; requeuedRunId: string; sessionAgentId: string | null }> = [];

    for (const stored of interruptedRuns) {
      const requeuedRunId = createCortexReviewRunId();

      await appendCortexReviewRun(this.config.paths.dataDir, {
        ...stored,
        interruptedAt: reconciledAt,
        interruptionReason
      });

      await appendCortexReviewRun(this.config.paths.dataDir, {
        runId: requeuedRunId,
        trigger: stored.trigger,
        scope: stored.scope,
        scopeLabel: stored.scopeLabel,
        requestText: stored.requestText,
        requestedAt: reconciledAt,
        sessionAgentId: null,
        sourceContext: stored.sourceContext ?? { channel: "web" },
        scheduleName: stored.scheduleName ?? null
      });

      reconciledPairs.push({
        interruptedRunId: stored.runId,
        requeuedRunId,
        sessionAgentId: stored.sessionAgentId
      });
    }

    console.warn(`[swarm][${reconciledAt}] cortex:review_runs:reconciled_interrupted`, {
      count: reconciledPairs.length,
      runs: reconciledPairs
    });
  }

  async listCortexReviewRuns(): Promise<CortexReviewRunRecord[]> {
    if (!this.config.cortexEnabled) {
      return [];
    }

    const storedRuns = await readStoredCortexReviewRuns(this.config.paths.dataDir);
    const queuedRunIdsByPosition = new Map<string, number>();

    storedRuns
      .filter((stored) => !stored.blockedReason && !stored.sessionAgentId)
      .slice()
      .reverse()
      .forEach((stored, index) => {
        queuedRunIdsByPosition.set(stored.runId, index + 1);
      });

    return storedRuns.map((stored) => {
      const sessionDescriptor = stored.sessionAgentId ? this.descriptors.get(stored.sessionAgentId) : undefined;
      const activeWorkerCount = stored.sessionAgentId
        ? this.getWorkersForManager(stored.sessionAgentId).filter((worker) => worker.status === "streaming").length
        : 0;

      return buildLiveCortexReviewRunRecord({
        stored,
        sessionDescriptor,
        activeWorkerCount,
        history: stored.sessionAgentId ? this.getConversationHistory(stored.sessionAgentId) : [],
        queuePosition: queuedRunIdsByPosition.get(stored.runId) ?? null
      });
    });
  }

  async startCortexReviewRun(input: {
    scope: CortexReviewRunScope;
    trigger: CortexReviewRunTrigger;
    sourceContext?: MessageSourceContext;
    requestText?: string;
    scheduleName?: string | null;
  }): Promise<CortexReviewRunRecord | null> {
    if (!this.config.cortexEnabled) {
      return null;
    }

    const runId = createCortexReviewRunId();
    let startedRunId: string | null = null;

    await this.withCortexReviewRunStartLock(async () => {
      if (input.trigger === "scheduled" && input.scope.mode === "all") {
        const storedRuns = await readStoredCortexReviewRuns(this.config.paths.dataDir);
        const queuedAllScopeRun = storedRuns.find((stored) => (
          !stored.blockedReason &&
          !stored.interruptedAt &&
          !stored.sessionAgentId &&
          stored.scope.mode === "all"
        ));

        if (queuedAllScopeRun) {
          this.logDebug("cortex:review_run:coalesced", {
            reason: "all-scope run already queued",
            existingRunId: queuedAllScopeRun.runId
          });
          return;
        }

        const activeReviewSession = this.getActiveCortexReviewSession();
        if (activeReviewSession) {
          const activeAllScopeRun = storedRuns.find((stored) => (
            !stored.blockedReason &&
            !stored.interruptedAt &&
            stored.sessionAgentId === activeReviewSession.agentId &&
            stored.scope.mode === "all"
          ));

          if (activeAllScopeRun) {
            this.logDebug("cortex:review_run:coalesced", {
              reason: "all-scope run already active",
              activeRunId: activeAllScopeRun.runId
            });
            return;
          }
        }
      }

      await this.ensureCortexProfile();

      await appendCortexReviewRun(this.config.paths.dataDir, {
        runId,
        trigger: input.trigger,
        scope: input.scope,
        scopeLabel: buildCortexReviewRunScopeLabel(input.scope),
        requestText: input.requestText?.trim() || buildCortexReviewRunRequestText(input.scope),
        requestedAt: this.now(),
        sessionAgentId: null,
        sourceContext: input.sourceContext ?? { channel: "web" },
        scheduleName: input.scheduleName ?? null
      });

      startedRunId = runId;
      await this.startNextQueuedCortexReviewRun();
    });

    if (!startedRunId) {
      return null;
    }

    this.scheduleCortexReviewRunQueueCheck();
    return this.getCortexReviewRunByIdOrThrow(startedRunId);
  }

  private async withCortexReviewRunStartLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.cortexReviewRunStartMutex;
    let release: (() => void) | undefined;
    this.cortexReviewRunStartMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private getActiveCortexReviewSession(): AgentDescriptor | undefined {
    return Array.from(this.descriptors.values()).find((descriptor) => (
      descriptor.role === "manager" &&
      descriptor.profileId === CORTEX_PROFILE_ID &&
      descriptor.sessionPurpose === "cortex_review" &&
      (
        descriptor.status === "streaming" ||
        this.getWorkersForManager(descriptor.agentId).some((worker) => worker.status === "streaming")
      )
    ));
  }

  private async getCortexReviewRunByIdOrThrow(runId: string): Promise<CortexReviewRunRecord> {
    const runs = await this.listCortexReviewRuns();
    const run = runs.find((entry) => entry.runId === runId);
    if (!run) {
      throw new Error(`Unable to load Cortex review run ${runId}`);
    }
    return run;
  }

  private async startNextQueuedCortexReviewRun(): Promise<CortexReviewRunRecord | null> {
    const activeReviewSession = this.getActiveCortexReviewSession();
    if (activeReviewSession) {
      return null;
    }

    const queuedRun = await this.findNextQueuedCortexReviewRun();
    if (!queuedRun) {
      this.clearCortexReviewRunQueueCheck();
      return null;
    }

    const label = queuedRun.scope.mode === "all"
      ? "Review Run · Full Queue"
      : `Review Run · ${queuedRun.scope.profileId}/${queuedRun.scope.sessionId}`;

    const { sessionAgent } = await this.createSession(CORTEX_PROFILE_ID, {
      label,
      sessionPurpose: "cortex_review"
    });

    await appendCortexReviewRun(this.config.paths.dataDir, {
      ...queuedRun,
      sessionAgentId: sessionAgent.agentId,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" }
    });

    await this.handleUserMessage(queuedRun.requestText, {
      targetAgentId: sessionAgent.agentId,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" }
    });

    return this.getCortexReviewRunByIdOrThrow(queuedRun.runId);
  }

  private async findNextQueuedCortexReviewRun(): Promise<StoredCortexReviewRun | null> {
    const storedRuns = await readStoredCortexReviewRuns(this.config.paths.dataDir);
    const nextQueued = storedRuns
      .slice()
      .reverse()
      .find((stored) => !stored.blockedReason && !stored.sessionAgentId);

    return nextQueued ?? null;
  }

  private scheduleCortexReviewRunQueueCheck(delayMs = CORTEX_REVIEW_RUN_QUEUE_RETRY_MS): void {
    if (!this.config.cortexEnabled) {
      this.clearCortexReviewRunQueueCheck();
      return;
    }

    this.clearCortexReviewRunQueueCheck();

    const timer = setTimeout(() => {
      this.cortexReviewRunQueueTimer = null;
      void this.processCortexReviewRunQueue().catch((error) => {
        this.logDebug("cortex:review_queue:error", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      });
    }, Math.max(0, delayMs));

    timer.unref?.();
    this.cortexReviewRunQueueTimer = timer;
  }

  private clearCortexReviewRunQueueCheck(): void {
    if (!this.cortexReviewRunQueueTimer) {
      return;
    }

    clearTimeout(this.cortexReviewRunQueueTimer);
    this.cortexReviewRunQueueTimer = null;
  }

  private async processCortexReviewRunQueue(): Promise<void> {
    if (!this.config.cortexEnabled) {
      this.clearCortexReviewRunQueueCheck();
      return;
    }

    await this.withCortexReviewRunStartLock(async () => {
      const activeReviewSession = this.getActiveCortexReviewSession();
      const queuedRun = await this.findNextQueuedCortexReviewRun();

      if (!queuedRun) {
        this.clearCortexReviewRunQueueCheck();
        return;
      }

      if (activeReviewSession) {
        this.scheduleCortexReviewRunQueueCheck();
        return;
      }

      await this.ensureCortexProfile();
      await this.startNextQueuedCortexReviewRun();
      this.scheduleCortexReviewRunQueueCheck();
    });
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId);
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
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) throw new Error(`Agent not found: ${agentId}`);

    const sessionAgentId = descriptor.role === "manager"
      ? agentId
      : descriptor.managerId;

    const choiceId = randomUUID().slice(0, 12);

    const pendingEvent: ChoiceRequestEvent = {
      type: "choice_request",
      agentId,
      choiceId,
      questions,
      status: "pending",
      timestamp: this.now(),
    };
    this.emitChoiceRequest(pendingEvent);

    return new Promise<ChoiceAnswer[]>((resolve, reject) => {
      this.pendingChoiceRequests.set(choiceId, {
        choiceId,
        agentId,
        sessionAgentId,
        questions,
        resolve,
        reject,
        createdAt: this.now(),
      });
      this.emitAgentsSnapshot();
    });
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) return;

    this.pendingChoiceRequests.delete(choiceId);

    const answeredEvent: ChoiceRequestEvent = {
      type: "choice_request",
      agentId: pending.agentId,
      choiceId,
      questions: pending.questions,
      status: "answered",
      answers,
      timestamp: this.now(),
    };
    this.emitChoiceRequest(answeredEvent);

    pending.resolve(answers);
    this.emitAgentsSnapshot();
  }

  cancelChoiceRequest(choiceId: string, reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">): void {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) return;

    this.pendingChoiceRequests.delete(choiceId);

    const cancelledEvent: ChoiceRequestEvent = {
      type: "choice_request",
      agentId: pending.agentId,
      choiceId,
      questions: pending.questions,
      status: reason,
      timestamp: this.now(),
    };
    this.emitChoiceRequest(cancelledEvent);

    pending.reject(new ChoiceRequestCancelledError(reason));
    this.emitAgentsSnapshot();
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    for (const [choiceId, pending] of this.pendingChoiceRequests) {
      if (pending.agentId === agentId || pending.sessionAgentId === agentId) {
        this.cancelChoiceRequest(choiceId, "cancelled");
      }
    }
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) return true;
    }
    return false;
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    const ids: string[] = [];
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        ids.push(pending.choiceId);
      }
    }
    return ids;
  }

  getPendingChoiceOwner(choiceId: string): { agentId: string; sessionAgentId: string } | undefined {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) return undefined;
    return { agentId: pending.agentId, sessionAgentId: pending.sessionAgentId };
  }

  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return undefined;
    }

    return {
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
      questions: pending.questions,
    };
  }

  async createSession(
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const prepared = this.prepareSessionCreation(profileId, options);
    const sessionDescriptor = prepared.sessionDescriptor;
    this.descriptors.set(sessionDescriptor.agentId, sessionDescriptor);

    await this.ensureSessionFileParentDirectory(sessionDescriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(sessionDescriptor.agentId), prepared.profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, prepared.profile.profileId), prepared.profile.profileId);
    await this.writeInitialSessionMeta(sessionDescriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(sessionDescriptor);
      sessionDescriptor.contextUsage = runtime.getContextUsage();
    } catch (error) {
      await this.rollbackCreatedSession(sessionDescriptor);
      throw error;
    }

    await this.saveStore();
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor
    });
    this.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId: prepared.profile.profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    if (sessionDescriptor.sessionPurpose === "agent_creator") {
      await this.injectAgentCreatorContext(sessionDescriptor.agentId, prepared.profile.profileId);
    }

    return {
      profile: { ...prepared.profile },
      sessionAgent: cloneDescriptor(sessionDescriptor)
    };
  }

  async createAndPromoteProjectAgent(
    creatorAgentId: string,
    params: { sessionName: string; handle?: string; whenToUse: string; systemPrompt: string }
  ): Promise<{ agentId: string; handle: string; profileId: string }> {
    const creatorDescriptor = this.getRequiredSessionDescriptor(creatorAgentId);
    if (creatorDescriptor.sessionPurpose !== "agent_creator") {
      throw new Error("Only agent_creator sessions can create project agents");
    }

    const profileId = creatorDescriptor.profileId;
    const trimmedName = params.sessionName.trim();
    const trimmedWhenToUse = normalizeProjectAgentInlineText(params.whenToUse);
    const trimmedSystemPrompt = params.systemPrompt.trim();

    if (!trimmedName) {
      throw new Error("sessionName must be non-empty");
    }
    if (!trimmedWhenToUse) {
      throw new Error("whenToUse must be non-empty");
    }
    if (trimmedWhenToUse.length > 280) {
      throw new Error("whenToUse must be 280 characters or fewer");
    }
    if (!trimmedSystemPrompt) {
      throw new Error("systemPrompt must be non-empty");
    }

    const handleSource = params.handle ?? trimmedName;
    const handle = normalizeProjectAgentHandle(handleSource);
    if (!handle) {
      throw new Error("Project agent handle must contain at least one letter, number, or dash");
    }

    const collision = findProjectAgentByHandle(this.descriptors.values(), profileId, handle);
    if (collision) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }

    const onDiskCollision = await readProjectAgentRecord(this.config.paths.dataDir, profileId, handle);
    if (onDiskCollision) {
      throw new Error(getProjectAgentHandleCollisionError(handle));
    }

    // Keep this specialized path aligned with createSession(), but populate projectAgent
    // before runtime creation so the custom system prompt is active on first boot.
    const prepared = this.prepareSessionCreation(profileId, {
      name: trimmedName,
      label: trimmedName
    });
    const sessionDescriptor = prepared.sessionDescriptor;
    sessionDescriptor.projectAgent = {
      handle,
      whenToUse: trimmedWhenToUse,
      // DUAL-WRITE: systemPrompt kept in agents.json mirror for Electron rollback safety
      systemPrompt: trimmedSystemPrompt,
      creatorSessionId: creatorAgentId
    };
    this.descriptors.set(sessionDescriptor.agentId, sessionDescriptor);

    const previousCreatorResult = creatorDescriptor.agentCreatorResult
      ? { ...creatorDescriptor.agentCreatorResult }
      : undefined;

    try {
      await this.ensureSessionFileParentDirectory(sessionDescriptor.sessionFile);
      await this.ensureAgentMemoryFile(this.getAgentMemoryPath(sessionDescriptor.agentId), prepared.profile.profileId);
      await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, prepared.profile.profileId), prepared.profile.profileId);
      await this.writeInitialSessionMeta(sessionDescriptor);

      const persistedProjectAgentConfig: PersistedProjectAgentConfig = {
        version: 1,
        agentId: sessionDescriptor.agentId,
        handle,
        whenToUse: trimmedWhenToUse,
        creatorSessionId: creatorAgentId,
        promotedAt: sessionDescriptor.createdAt,
        updatedAt: this.now()
      };
      await writeProjectAgentRecord(
        this.config.paths.dataDir,
        profileId,
        persistedProjectAgentConfig,
        trimmedSystemPrompt
      );

      const runtime = await this.getOrCreateRuntimeForDescriptor(sessionDescriptor);
      sessionDescriptor.contextUsage = runtime.getContextUsage();

      creatorDescriptor.agentCreatorResult = {
        createdAgentId: sessionDescriptor.agentId,
        createdHandle: handle,
        createdAt: new Date().toISOString()
      };
      this.descriptors.set(creatorDescriptor.agentId, creatorDescriptor);

      await this.saveStore();
    } catch (error) {
      if (previousCreatorResult) {
        creatorDescriptor.agentCreatorResult = previousCreatorResult;
      } else {
        delete creatorDescriptor.agentCreatorResult;
      }
      this.descriptors.set(creatorDescriptor.agentId, creatorDescriptor);

      const cleanupResults = await Promise.allSettled([
        deleteProjectAgentRecord(this.config.paths.dataDir, profileId, handle),
        this.rollbackCreatedSession(sessionDescriptor)
      ]);
      for (const cleanupResult of cleanupResults) {
        if (cleanupResult.status === "rejected") {
          this.logDebug("project_agent:create:rollback_cleanup_error", {
            creatorAgentId,
            agentId: sessionDescriptor.agentId,
            handle,
            message: cleanupResult.reason instanceof Error ? cleanupResult.reason.message : String(cleanupResult.reason)
          });
        }
      }

      throw error;
    }
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor
    });
    this.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();
    this.emitSessionProjectAgentUpdated(sessionDescriptor.agentId, profileId, sessionDescriptor.projectAgent ?? null);
    await this.notifyProjectAgentsChanged(profileId);

    return {
      agentId: sessionDescriptor.agentId,
      handle,
      profileId
    };
  }

  async stopSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const { terminatedWorkerIds } = await this.stopSessionInternal(agentId, {
      saveStore: true,
      emitSnapshots: true
    });

    return { terminatedWorkerIds };
  }

  async resumeSession(agentId: string): Promise<void> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);

    if (this.runtimes.has(agentId)) {
      throw new Error(`Session is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Session is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Session is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.now();
    this.descriptors.set(agentId, descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.descriptors.set(agentId, descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.now();
      this.descriptors.set(agentId, descriptor);
      throw error;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();
  }

  async deleteSession(agentId: string): Promise<{ terminatedWorkerIds: string[] }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    this.assertSessionIsDeletable(descriptor);
    const forgeLifecycleSessionDescriptor = cloneDescriptor(descriptor);
    const wasProjectAgent = Boolean(descriptor.projectAgent);
    const projectAgentHandle = descriptor.projectAgent?.handle;

    const { terminatedWorkerIds } = await this.stopSessionInternal(agentId, {
      saveStore: false,
      emitSnapshots: false,
      emitStatus: false,
      deleteWorkers: true
    });

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sessionDir = getSessionDir(this.config.paths.dataDir, profileId, descriptor.agentId);
    const workersDir = getWorkersDir(this.config.paths.dataDir, profileId, descriptor.agentId);
    const canonicalSessionFile = getSessionFilePath(this.config.paths.dataDir, profileId, descriptor.agentId);
    const sessionMetaPath = getSessionMetaPath(this.config.paths.dataDir, profileId, descriptor.agentId);
    const sessionMemoryPath = resolveMemoryFilePath(this.config.paths.dataDir, {
      agentId: descriptor.agentId,
      role: "manager",
      profileId,
      managerId: descriptor.managerId
    });

    this.descriptors.delete(agentId);
    this.pinnedMessageIdsBySessionAgentId.delete(agentId);
    this.conversationProjector.deleteConversationHistory(agentId, descriptor.sessionFile);

    if (descriptor.sessionFile === canonicalSessionFile) {
      await rm(sessionDir, { recursive: true, force: true });
    } else {
      await this.deleteManagerSessionFile(descriptor.sessionFile);
      await rm(sessionMetaPath, { force: true });
      await rm(sessionMemoryPath, { force: true });
      await rm(workersDir, { recursive: true, force: true });
      await rm(sessionDir, { recursive: true, force: true });
    }

    if (wasProjectAgent && projectAgentHandle) {
      await deleteProjectAgentRecord(this.config.paths.dataDir, profileId, projectAgentHandle);
    }

    await this.saveStore();
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "deleted",
      sessionDescriptor: forgeLifecycleSessionDescriptor
    });
    this.emitSessionLifecycle({
      action: "deleted",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    if (wasProjectAgent) {
      await this.notifyProjectAgentsChanged(profileId);
    }

    return { terminatedWorkerIds };
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
    this.cancelAllPendingChoicesForAgent(agentId);

    const descriptor = this.getRequiredSessionDescriptor(agentId);

    // Truncate the session JSONL file on disk
    if (descriptor.sessionFile) {
      try {
        await writeFile(descriptor.sessionFile, "");
      } catch {
        // File may not exist yet — that's fine
      }
    }

    const emptyRegistry: PinRegistry = { version: 1, pins: {} };
    await savePins(this.getSessionDirForDescriptor(descriptor), emptyRegistry);
    await this.syncPinnedContentForManagerRuntime(descriptor, {
      registry: emptyRegistry,
      setPinnedContentOptions: { suppressRecycle: true }
    });

    // Clear in-memory conversation history
    this.conversationProjector.resetConversationHistory(agentId);

    const runtime = this.runtimes.get(agentId);
    if (runtime?.runtimeType === "claude") {
      try {
        await runtime.recycle();
      } catch (error) {
        this.logDebug("session:clear:claude_recycle_error", {
          agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (runtime) {
      await this.captureSessionRuntimePromptMeta(descriptor, runtime.getSystemPrompt?.());
    }

    // Notify connected clients to clear their message lists
    this.emitConversationReset(agentId, "api_reset");

    this.logDebug("session:clear", { agentId });
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
    projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string } | null
  ): Promise<{ profileId: string; projectAgent: NonNullable<AgentDescriptor["projectAgent"]> | null }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    this.assertSessionSupportsProjectAgent(descriptor);

    const profileId = descriptor.profileId;
    const previousProjectAgent = descriptor.projectAgent;
    const nextHandle = projectAgent?.handle !== undefined ? normalizeProjectAgentHandle(projectAgent.handle) : undefined;
    if (previousProjectAgent && nextHandle && nextHandle !== previousProjectAgent.handle) {
      throw new Error("Cannot change project agent handle after promotion. Demote and re-promote to change the handle.");
    }

    const nextProjectAgent = projectAgent
      ? this.buildProjectAgentInfoForSession(
          descriptor,
          projectAgent.whenToUse,
          projectAgent.systemPrompt,
          projectAgent.handle ?? descriptor.projectAgent?.handle
        )
      : null;

    if (nextProjectAgent) {
      const onDiskCollision = await readProjectAgentRecord(
        this.config.paths.dataDir,
        profileId,
        nextProjectAgent.handle
      );
      if (onDiskCollision && onDiskCollision.config.agentId !== descriptor.agentId) {
        throw new Error(getProjectAgentHandleCollisionError(nextProjectAgent.handle));
      }

      const persistedProjectAgentConfig: PersistedProjectAgentConfig = {
        version: 1,
        agentId: descriptor.agentId,
        handle: nextProjectAgent.handle,
        whenToUse: nextProjectAgent.whenToUse,
        ...(nextProjectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: nextProjectAgent.creatorSessionId }
          : {}),
        promotedAt: descriptor.createdAt,
        updatedAt: this.now()
      };
      const configForDisk = persistedProjectAgentConfig;
      if (previousProjectAgent && previousProjectAgent.handle !== nextProjectAgent.handle) {
        await renameProjectAgentRecord(
          this.config.paths.dataDir,
          profileId,
          previousProjectAgent.handle,
          nextProjectAgent.handle,
          configForDisk,
          nextProjectAgent.systemPrompt ?? null
        );
      } else {
        await writeProjectAgentRecord(
          this.config.paths.dataDir,
          profileId,
          configForDisk,
          nextProjectAgent.systemPrompt ?? null
        );
      }
    } else if (previousProjectAgent?.handle) {
      await deleteProjectAgentRecord(this.config.paths.dataDir, profileId, previousProjectAgent.handle);
    }

    descriptor.projectAgent = nextProjectAgent ?? undefined;
    this.descriptors.set(agentId, descriptor);

    try {
      await this.saveStore();
      await this.captureSessionRuntimePromptMeta(descriptor);
    } catch (error) {
      console.warn(
        `[swarm] project-agent-storage:post_commit_sync_failed agentId=${agentId} profile=${profileId} error=${errorToMessage(error)}`
      );
    }

    this.emitAgentsSnapshot();
    this.emitSessionProjectAgentUpdated(descriptor.agentId, profileId, nextProjectAgent);
    await this.notifyProjectAgentsChanged(profileId);

    return {
      profileId,
      projectAgent: cloneProjectAgentInfoValue(nextProjectAgent) ?? null
    };
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
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      throw new Error("Session label must be non-empty");
    }

    const previousLabel = descriptor.sessionLabel ?? descriptor.displayName ?? descriptor.agentId;
    const renamedAt = this.now();

    descriptor.sessionLabel = normalizedLabel;
    this.descriptors.set(agentId, descriptor);

    await this.writeInitialSessionMeta(descriptor);
    await this.appendSessionRenameHistoryEntry(descriptor, {
      from: previousLabel,
      to: normalizedLabel,
      renamedAt
    });
    await this.saveStore();
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "renamed",
      sessionDescriptor: descriptor
    });
    this.emitSessionLifecycle({
      action: "renamed",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId,
      label: normalizedLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    if (descriptor.projectAgent) {
      await this.notifyProjectAgentsChanged(descriptor.profileId);
    }
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
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const profileId = descriptor.profileId ?? descriptor.agentId;
    if (descriptor.agentId === profileId) {
      throw new Error(`Default session working memory merge is not supported: ${agentId}`);
    }

    const releaseMergeLock = await this.acquireProfileMergeLock(profileId);

    const mergedAt = this.now();
    const attemptId = `${descriptor.agentId}:${mergedAt}`;
    const auditPath = getProfileMergeAuditLogPath(this.config.paths.dataDir, profileId);
    const failureContext: SessionMemoryMergeFailureContext = {
      timestamp: mergedAt,
      attemptId,
      profileId,
      auditPath,
      stage: "prepare",
      profileContentHashBefore: "",
      llmMergeSucceeded: false,
      model: `${descriptor.model.provider}/${descriptor.model.modelId}`,
      appliedChange: false
    };

    try {
      const sessionMemoryPath = this.getAgentMemoryPath(agentId);
      const profileMemoryPath = getProfileMemoryPath(this.config.paths.dataDir, profileId);

      await this.ensureAgentMemoryFile(sessionMemoryPath, profileId);
      await this.ensureAgentMemoryFile(profileMemoryPath, profileId);

      failureContext.stage = "read_inputs";
      const [sessionMemoryContent, profileMemoryContent, existingMeta] = await Promise.all([
        readFile(sessionMemoryPath, "utf8"),
        readFile(profileMemoryPath, "utf8"),
        readSessionMeta(this.config.paths.dataDir, profileId, descriptor.agentId)
      ]);

      const sessionContentHash = hashMemoryMergeContent(sessionMemoryContent);
      const profileContentHashBefore = hashMemoryMergeContent(profileMemoryContent);
      const lastAppliedAt = existingMeta?.lastMemoryMergeAppliedAt ?? descriptor.mergedAt;
      failureContext.sessionContentHash = sessionContentHash;
      failureContext.profileContentHashBefore = profileContentHashBefore;

      if (this.isSessionMemoryMergeNoOp(sessionMemoryContent)) {
        failureContext.strategy = "template_noop";
        failureContext.model = "noop";
        failureContext.profileContentHashAfter = profileContentHashBefore;
        failureContext.stage = "record_attempt";
        await this.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy: "template_noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy: "template_noop",
          llmMergeSucceeded: false,
          usedFallbackAppend: false,
          appliedChange: false,
          model: "noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy: "template_noop",
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      if (
        this.shouldSkipSessionMemoryMergeIdempotently(
          existingMeta,
          sessionContentHash,
          profileContentHashBefore
        )
      ) {
        failureContext.strategy = "idempotent_noop";
        failureContext.model = "noop";
        failureContext.profileContentHashAfter = profileContentHashBefore;
        failureContext.stage = "record_attempt";
        await this.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy: "idempotent_noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy: "idempotent_noop",
          llmMergeSucceeded: false,
          usedFallbackAppend: false,
          appliedChange: false,
          model: "noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy: "idempotent_noop",
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      let mergedProfileMemory = finalizeMergedMemoryContent(profileMemoryContent);
      let llmMergeSucceeded = false;
      let mergeModel = "seed";
      let strategy: SessionMemoryMergeStrategy = "seed";
      failureContext.strategy = strategy;
      failureContext.model = mergeModel;

      if (normalizeMemoryMergeContent(profileMemoryContent).length === 0) {
        mergedProfileMemory = finalizeMergedMemoryContent(sessionMemoryContent);
      } else {
        failureContext.stage = "llm";
        failureContext.strategy = "llm";
        const llmMerge = await this.executeSessionMemoryLLMMerge(
          descriptor,
          profileMemoryContent,
          sessionMemoryContent
        );
        mergedProfileMemory = finalizeMergedMemoryContent(llmMerge.mergedContent);
        llmMergeSucceeded = true;
        mergeModel = llmMerge.model;
        strategy = "llm";
        failureContext.strategy = strategy;
        failureContext.model = mergeModel;
        failureContext.llmMergeSucceeded = true;
      }

      failureContext.profileContentHashAfter = hashMemoryMergeContent(mergedProfileMemory);
      const matchesCurrentProfileMemory =
        strategy === "llm" &&
        normalizeMemoryMergeContent(mergedProfileMemory) === normalizeMemoryMergeContent(profileMemoryContent);
      const shouldRepairPostApplyFailure = this.shouldRepairFailedPostApplyMerge(
        existingMeta,
        sessionContentHash,
        profileContentHashBefore
      );

      if (matchesCurrentProfileMemory && !shouldRepairPostApplyFailure) {
        strategy = "no_change";
        failureContext.strategy = strategy;
        failureContext.stage = "record_attempt";
        await this.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy,
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy,
          llmMergeSucceeded,
          usedFallbackAppend: false,
          appliedChange: false,
          model: mergeModel,
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy,
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      if (!matchesCurrentProfileMemory) {
        failureContext.stage = "write_profile_memory";
        await writeFile(profileMemoryPath, mergedProfileMemory, "utf8");
        failureContext.appliedChange = true;
        this.queueVersioningMutation({
          path: profileMemoryPath,
          action: "write",
          source: "profile-memory-merge",
          profileId,
          sessionId: descriptor.agentId,
          reviewRunId: await this.resolveActiveCortexReviewRunIdForDescriptor(descriptor)
        });
      }
      failureContext.stage = "refresh_session_meta_stats";
      await this.refreshSessionMetaStatsBySessionId(profileId);
      failureContext.stage = "record_attempt";
      await this.recordSessionMemoryMergeAttempt(descriptor, {
        attemptId,
        timestamp: mergedAt,
        status: "applied",
        strategy,
        sessionContentHash,
        profileContentHashBefore,
        profileContentHashAfter: failureContext.profileContentHashAfter,
        appliedSourceHash: sessionContentHash
      });

      descriptor.mergedAt = mergedAt;
      descriptor.updatedAt = mergedAt;
      this.descriptors.set(descriptor.agentId, descriptor);

      failureContext.stage = "save_store";
      await this.saveStore();
      failureContext.stage = "write_audit";
      await this.appendSessionMemoryMergeAuditEntry({
        attemptId,
        timestamp: mergedAt,
        sessionAgentId: descriptor.agentId,
        profileId,
        status: "applied",
        strategy,
        llmMergeSucceeded,
        usedFallbackAppend: false,
        appliedChange: true,
        model: mergeModel,
        sessionContentHash,
        profileContentHashBefore,
        profileContentHashAfter: failureContext.profileContentHashAfter
      });

      this.emitAgentsSnapshot();

      return {
        agentId: descriptor.agentId,
        status: "applied",
        strategy,
        mergedAt,
        auditPath
      };
    } catch (error) {
      throw await this.finalizeSessionMemoryMergeFailure(descriptor, failureContext, error);
    } finally {
      releaseMergeLock();
    }
  }

  async forkSession(
    sourceAgentId: string,
    options?: { label?: string; fromMessageId?: string }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = this.getRequiredSessionDescriptor(sourceAgentId);
    const profile = this.profiles.get(sourceDescriptor.profileId);
    const normalizedFromMessageId = options?.fromMessageId?.trim() || undefined;
    if (!profile) {
      throw new Error(`Unknown profile: ${sourceDescriptor.profileId}`);
    }

    const prepared = this.prepareSessionCreation(profile.profileId, {
      label: options?.label,
      name: options?.label
    });
    const forkedDescriptor = prepared.sessionDescriptor as AgentDescriptor & { role: "manager"; profileId: string };
    this.descriptors.set(forkedDescriptor.agentId, forkedDescriptor);

    await this.ensureSessionFileParentDirectory(forkedDescriptor.sessionFile);
    await this.writeInitialSessionMeta(forkedDescriptor);

    try {
      await this.copySessionHistoryForFork(
        sourceDescriptor.sessionFile,
        forkedDescriptor.sessionFile,
        normalizedFromMessageId
      );
      await this.copyPinnedMessagesForFork(sourceDescriptor, forkedDescriptor);
      await this.writeForkedSessionMemoryHeader(
        sourceDescriptor,
        forkedDescriptor.agentId,
        normalizedFromMessageId
      );

      const runtime = await this.getOrCreateRuntimeForDescriptor(forkedDescriptor);
      forkedDescriptor.contextUsage = runtime.getContextUsage();
      this.descriptors.set(forkedDescriptor.agentId, forkedDescriptor);

      await this.saveStore();
    } catch (error) {
      await this.rollbackCreatedSession(forkedDescriptor);
      throw error;
    }

    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "forked",
      sessionDescriptor: forkedDescriptor,
      sourceDescriptor
    });
    this.emitSessionLifecycle({
      action: "forked",
      sessionAgentId: forkedDescriptor.agentId,
      sourceAgentId: sourceDescriptor.agentId,
      profileId: profile.profileId,
      label: forkedDescriptor.sessionLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    return {
      profile: { ...profile },
      sessionAgent: cloneDescriptor(forkedDescriptor)
    };
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.now();
    const managerProfileId = manager.profileId ?? manager.agentId;
    const rawSpecialist = input.specialist?.trim();
    let requestedSpecialistId: string | undefined;

    if (rawSpecialist) {
      const specialistModule = await this.loadSpecialistRegistryModule();
      requestedSpecialistId = specialistModule.normalizeSpecialistHandle(rawSpecialist) || undefined;
    }

    if (
      requestedSpecialistId &&
      (
        input.model !== undefined ||
        input.modelId !== undefined ||
        input.systemPrompt !== undefined ||
        input.archetypeId !== undefined
      )
    ) {
      throw new Error(
        "Cannot combine 'specialist' with model/prompt/archetype overrides. Use specialist mode or ad-hoc mode, not both. reasoningLevel is the only allowed override in specialist mode."
      );
    }

    let model: AgentModelDescriptor;
    let archetypeId: string | undefined;
    let specialist: ResolvedSpecialistDefinitionLike | undefined;
    let specialistFallbackModel: AgentModelDescriptor | undefined;
    let explicitSystemPrompt: string | undefined;
    let webSearch = false;

    if (requestedSpecialistId) {
      const roster = await this.resolveSpecialistRosterForProfile(managerProfileId);
      specialist = roster.find((entry) => entry.specialistId === requestedSpecialistId);
      if (!specialist) {
        throw new Error(
          `Unknown specialist: ${requestedSpecialistId}. See manager system prompt for available specialists.`
        );
      }

      if (!specialist.enabled) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" is disabled for this profile. Enable it before spawning.`
        );
      }

      if (!specialist.available) {
        const reason =
          specialist.availabilityMessage?.trim() ||
          (specialist.availabilityCode
            ? `availability code: ${specialist.availabilityCode}`
            : "unavailable with current auth/configuration");
        throw new Error(`Specialist "${requestedSpecialistId}" is currently unavailable: ${reason}`);
      }

      const inferredProvider = specialist.provider || inferProviderFromModelId(specialist.modelId);
      if (!inferredProvider) {
        throw new Error(
          `Specialist "${requestedSpecialistId}" has an unknown modelId provider mapping: ${specialist.modelId}`
        );
      }

      const reasoningLevelOverride = parseSwarmReasoningLevel(
        input.reasoningLevel,
        "spawn_agent.reasoningLevel"
      );

      model = {
        provider: inferredProvider,
        modelId: specialist.modelId,
        thinkingLevel: reasoningLevelOverride ?? specialist.reasoningLevel ?? "xhigh"
      };
      model.thinkingLevel = normalizeThinkingLevelForProvider(model.provider, model.thinkingLevel);
      model = this.resolveSpawnModelWithCapacityFallback(model);

      if (specialist.fallbackModelId) {
        const inferredFallbackProvider = specialist.fallbackProvider || inferProviderFromModelId(specialist.fallbackModelId);
        if (inferredFallbackProvider) {
          specialistFallbackModel = {
            provider: inferredFallbackProvider,
            modelId: specialist.fallbackModelId,
            thinkingLevel: specialist.fallbackReasoningLevel ?? model.thinkingLevel
          };
          specialistFallbackModel.thinkingLevel = normalizeThinkingLevelForProvider(
            specialistFallbackModel.provider,
            specialistFallbackModel.thinkingLevel
          );
          specialistFallbackModel = this.resolveSpawnModelWithCapacityFallback(specialistFallbackModel);
        }
      }

      archetypeId = undefined;
      explicitSystemPrompt = specialist.promptBody;
    } else {
      const requestedModel = this.resolveSpawnModel(input, manager.model);
      model = this.resolveSpawnModelWithCapacityFallback(requestedModel);
      archetypeId = await this.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);
      explicitSystemPrompt = input.systemPrompt?.trim();
      webSearch = input.webSearch === true;
    }

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      profileId: manager.profileId ?? manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: getWorkerSessionFilePath(
        this.config.paths.dataDir,
        manager.profileId ?? manager.agentId,
        manager.agentId,
        agentId
      ),
      ...(webSearch ? { webSearch: true } : {})
    };

    if (specialist) {
      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      if (specialist.webSearch) {
        descriptor.webSearch = true;
      }
    }

    this.descriptors.set(agentId, descriptor);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.saveStore();
    // Emit early snapshot so the UI sees the updated workerCount immediately,
    // before the potentially slow runtime creation.
    this.emitAgentsSnapshot();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      specialistId: descriptor.specialistId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    try {
      const baseSystemPrompt =
        explicitSystemPrompt && explicitSystemPrompt.length > 0
          ? explicitSystemPrompt
          : await this.resolveSystemPromptForDescriptor(descriptor);

      const runtimeSystemPrompt = this.injectWorkerIdentityContext(descriptor, baseSystemPrompt);

      let runtime: SwarmAgentRuntime;
      try {
        runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
      } catch (error) {
        if (specialistFallbackModel && shouldRetrySpecialistSpawnWithFallback(error, descriptor.model)) {
          const previousModel = { ...descriptor.model };
          descriptor.model = { ...specialistFallbackModel };
          this.descriptors.set(agentId, descriptor);
          await this.saveStore();

          this.logDebug("agent:spawn:specialist_fallback_retry", {
            agentId,
            specialistId: specialist?.specialistId,
            previousModel,
            fallbackModel: descriptor.model,
            error: error instanceof Error ? error.message : String(error)
          });

          runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
        } else {
          throw error;
        }
      }

      this.runtimes.set(agentId, runtime);
      this.seedWorkerCompletionReportTimestamp(agentId);

      const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      const contextUsage = runtime.getContextUsage();
      descriptor.contextUsage = contextUsage;
      this.descriptors.set(agentId, descriptor);
      await this.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
      this.emitAgentsSnapshot();
    } catch (error) {
      try {
        if (this.runtimes.has(agentId)) {
          const shutdown = await this.runRuntimeShutdown(descriptor, "terminate", { abort: true });
          this.detachRuntime(agentId, shutdown.runtimeToken);
        }
      } catch (shutdownError) {
        this.logDebug("agent:spawn:rollback_runtime_error", {
          agentId,
          error: String(shutdownError)
        });
      }

      this.clearWatchdogState(agentId);
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      this.lastWorkerCompletionReportTimestampByAgentId.delete(agentId);
      this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(agentId);

      this.descriptors.delete(agentId);
      this.emitAgentsSnapshot();
      await this.saveStore();

      try {
        await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
      } catch (metaError) {
        this.logDebug("agent:spawn:rollback_meta_error", {
          agentId,
          managerId: descriptor.managerId,
          error: String(metaError)
        });
      }

      throw error;
    }

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.assertManager(callerAgentId, "kill agents");

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.saveStore();

    this.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.emitStatus(targetAgentId, target.status, 0);
    this.emitAgentsSnapshot();
  }

  async stopWorker(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      const shutdown = await this.runRuntimeShutdown(descriptor, "terminate", { abort: true });
      this.detachRuntime(agentId, shutdown.runtimeToken);
    }

    if (descriptor.role === "worker") {
      this.clearWatchdogState(agentId);
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      this.lastWorkerCompletionReportTimestampByAgentId.delete(agentId);
      this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(agentId);
    }

    descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(agentId, descriptor);

    await this.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    await this.saveStore();

    this.emitStatus(agentId, descriptor.status, 0);
    this.emitAgentsSnapshot();
  }

  async resumeWorker(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      throw new Error(`Unknown worker agent: ${agentId}`);
    }

    if (this.runtimes.has(agentId)) {
      throw new Error(`Worker is already running: ${agentId}`);
    }

    const previousStatus = descriptor.status;
    if (descriptor.status === "error") {
      throw new Error(`Worker is not resumable from error status: ${agentId}`);
    }

    if (
      descriptor.status !== "idle" &&
      descriptor.status !== "terminated" &&
      descriptor.status !== "stopped"
    ) {
      throw new Error(`Worker is not resumable from status ${descriptor.status}: ${agentId}`);
    }

    if (isNonRunningAgentStatus(descriptor.status)) {
      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
    }

    descriptor.updatedAt = this.now();
    this.descriptors.set(agentId, descriptor);

    try {
      const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);
      descriptor.contextUsage = runtime.getContextUsage();
      this.descriptors.set(agentId, descriptor);
    } catch (error) {
      descriptor.status = previousStatus;
      descriptor.updatedAt = this.now();
      this.descriptors.set(agentId, descriptor);
      throw error;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();
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
    const manager = this.assertManager(callerAgentId, "stop all agents");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    const stoppedWorkerIds: string[] = [];
    const managerRuntime = this.runtimes.get(target.agentId);
    if (managerRuntime && (target.status === "streaming" || managerRuntime.getStatus() === "streaming")) {
      this.markPendingManualManagerStopNotice(target.agentId);
    }

    this.cancelAllPendingChoicesForAgent(targetManagerId);

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      this.clearWatchdogState(descriptor.agentId);
      this.workerStallState.delete(descriptor.agentId);
      this.workerActivityState.delete(descriptor.agentId);

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.runRuntimeShutdown(descriptor, "stopInFlight", { abort: true });
        this.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      }

      descriptor.status = transitionAgentStatus(descriptor.status, "idle");
      descriptor.contextUsage = undefined;
      descriptor.updatedAt = this.now();
      this.descriptors.set(descriptor.agentId, descriptor);
      await this.updateSessionMetaForWorkerDescriptor(descriptor);
      this.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (!isNonRunningAgentStatus(target.status)) {
      if (managerRuntime) {
        const shutdown = await this.runRuntimeShutdown(target, "stopInFlight", { abort: true });
        this.detachRuntime(target.agentId, shutdown.runtimeToken);
      }

      target.status = transitionAgentStatus(target.status, "idle");
      target.contextUsage = undefined;
      target.updatedAt = this.now();
      this.descriptors.set(target.agentId, target);
      this.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      managerStopped = true;
    }

    await this.refreshSessionMetaStatsBySessionId(targetManagerId);
    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      // Backward compatibility for older clients still expecting terminated-oriented fields.
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.hasRunningManagers({ excludeCortex: true });
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (isNonRunningAgentStatus(callerDescriptor.status)) {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const normalizedRequestedName = normalizeAgentId(requestedName);
    if (normalizedRequestedName === CORTEX_PROFILE_ID) {
      throw new Error('The manager name "cortex" is reserved');
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const managerId = this.generateUniqueManagerId(requestedName);
    const createdAt = this.now();
    const cwd = await this.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      profileId: managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: requestedModelPreset
        ? resolveModelDescriptorFromPreset(requestedModelPreset)
        : this.resolveDefaultModelDescriptor(),
      sessionFile: getSessionFilePath(this.config.paths.dataDir, managerId, managerId)
    };

    // Canonicalize sortOrder for all existing profiles if any lack it,
    // so the new profile's sortOrder correctly places it at the bottom.
    this.materializeSortOrder();

    const maxSortOrder = Array.from(this.profiles.values()).reduce(
      (max, p) => Math.max(max, p.sortOrder ?? -1),
      -1
    );

    const profile: ManagerProfile = {
      profileId: descriptor.agentId,
      displayName: descriptor.displayName,
      defaultSessionAgentId: descriptor.agentId,
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt,
      sortOrder: maxSortOrder + 1
    };

    this.descriptors.set(descriptor.agentId, descriptor);
    this.profiles.set(profile.profileId, profile);

    await this.ensureProfileDirectories(profile.profileId);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);

    const systemPrompt = await this.resolveSystemPromptForDescriptor(descriptor);
    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(descriptor, systemPrompt);
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      this.profiles.delete(profile.profileId);
      await rm(getSessionMetaPath(this.config.paths.dataDir, profile.profileId, descriptor.agentId), { force: true });
      throw error;
    }

    this.runtimes.set(managerId, runtime);

    const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;
    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.descriptors.set(managerId, descriptor);

    await this.captureSessionRuntimePromptMeta(descriptor, persistedSystemPrompt);
    await this.refreshSessionMetaStats(descriptor);
    await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profile.profileId, {
      versioning: this.versioningService
    });
    await this.saveStore();
    await this.forgeExtensionHost.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: descriptor
    });

    this.emitStatus(managerId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    this.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.assertManager(callerAgentId, "delete managers");

    const profile = this.profiles.get(targetManagerId);
    const sessionDescriptors = profile ? this.getSessionsForProfile(profile.profileId) : [];

    if (sessionDescriptors.length === 0) {
      const target = this.descriptors.get(targetManagerId);
      if (!target || target.role !== "manager") {
        throw new Error(`Unknown manager: ${targetManagerId}`);
      }
      sessionDescriptors.push(target);
    }

    if (sessionDescriptors.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)) {
      throw new Error("Cortex manager cannot be deleted");
    }

    const terminatedWorkerIds: string[] = [];
    const forgeLifecycleSessionDescriptors = sessionDescriptors.map((sessionDescriptor) => cloneDescriptor(sessionDescriptor));

    for (const sessionDescriptor of sessionDescriptors) {
      for (const workerDescriptor of this.getWorkersForManager(sessionDescriptor.agentId)) {
        terminatedWorkerIds.push(workerDescriptor.agentId);
        await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true });
        this.descriptors.delete(workerDescriptor.agentId);
        this.conversationProjector.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
      }

      await this.terminateDescriptor(sessionDescriptor, { abort: true, emitStatus: true });
      this.descriptors.delete(sessionDescriptor.agentId);
      this.conversationProjector.deleteConversationHistory(sessionDescriptor.agentId, sessionDescriptor.sessionFile);
    }

    if (profile) {
      this.profiles.delete(profile.profileId);
    } else {
      this.profiles.delete(targetManagerId);
    }

    const schedulesProfileId = profile?.profileId ?? sessionDescriptors[0]?.profileId ?? targetManagerId;
    await this.deleteManagerSchedulesFile(schedulesProfileId);

    await this.saveStore();
    for (const sessionDescriptor of forgeLifecycleSessionDescriptors) {
      await this.forgeExtensionHost.dispatchSessionLifecycle({
        action: "deleted",
        sessionDescriptor
      });
    }
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    this.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  async updateManagerModel(
    managerId: string,
    modelPreset: SwarmModelPreset,
    reasoningLevel?: SwarmReasoningLevel
  ): Promise<void> {
    const profile = this.profiles.get(managerId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${managerId}`);
    }

    const modelDescriptor = resolveModelDescriptorFromPreset(modelPreset);
    if (reasoningLevel) {
      modelDescriptor.thinkingLevel = reasoningLevel;
    }
    const sessions = this.getSessionsForProfile(profile.profileId);
    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];

    for (const session of sessions) {
      session.model = { ...modelDescriptor };
      // Intentionally do NOT bump updatedAt — model changes are config updates,
      // not user-visible activity, and bumping would scramble session sort order.
      this.descriptors.set(session.agentId, session);

      const recycleDisposition = await this.applyManagerRuntimeRecyclePolicy(session.agentId, "model_change");
      if (recycleDisposition === "recycled") {
        recycledSessions.push(session.agentId);
      } else if (recycleDisposition === "deferred") {
        deferredSessions.push(session.agentId);
      }
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:update_model", {
      managerId,
      modelPreset,
      reasoningLevel,
      updatedSessions: sessions.map((s) => s.agentId),
      recycledSessions,
      deferredSessions
    });
  }

  async updateManagerCwd(managerId: string, newCwd: string): Promise<string> {
    const profile = this.profiles.get(managerId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${managerId}`);
    }

    const sessions = this.getSessionsForProfile(profile.profileId);
    if (
      profile.profileId === CORTEX_PROFILE_ID ||
      sessions.some((descriptor) => normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID)
    ) {
      throw new Error("Cannot change working directory for Cortex profile");
    }

    const resolvedCwd = await this.resolveAndValidateCwd(newCwd);
    if (sessions.every((session) => session.cwd === resolvedCwd)) {
      this.logDebug("manager:update_cwd:noop", {
        managerId,
        newCwd: resolvedCwd,
        updatedSessions: []
      });
      return resolvedCwd;
    }

    const recycledSessions: string[] = [];
    const deferredSessions: string[] = [];
    const recycleFailures: Array<{ agentId: string; error: string }> = [];

    for (const session of sessions) {
      session.cwd = resolvedCwd;
      // Intentionally do NOT bump updatedAt — CWD changes are config updates,
      // not user-visible activity, and bumping would scramble session sort order.
      this.descriptors.set(session.agentId, session);
    }

    for (const session of sessions) {
      try {
        const recycleDisposition = await this.applyManagerRuntimeRecyclePolicy(session.agentId, "cwd_change");
        if (recycleDisposition === "recycled") {
          recycledSessions.push(session.agentId);
        } else if (recycleDisposition === "deferred") {
          deferredSessions.push(session.agentId);
        }
      } catch (error) {
        recycleFailures.push({
          agentId: session.agentId,
          error: errorToMessage(error)
        });
      }
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    if (recycleFailures.length > 0) {
      console.warn(`[swarm] manager:update_cwd:recycle_failed managerId=${managerId} failures=${JSON.stringify(recycleFailures)}`);
    }

    this.logDebug("manager:update_cwd", {
      managerId,
      newCwd: resolvedCwd,
      updatedSessions: sessions.map((s) => s.agentId),
      recycledSessions,
      deferredSessions,
      recycleFailures
    });

    return resolvedCwd;
  }

  async notifySpecialistRosterChanged(profileId: string): Promise<void> {
    try {
      const roster = await this.resolveSpecialistRosterForProfile(profileId);
      await this.syncWorkerSpecialistMetadata(profileId, roster);
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

  private async syncWorkerSpecialistMetadata(
    profileId: string,
    roster: ResolvedSpecialistDefinitionLike[]
  ): Promise<void> {
    const rosterById = new Map(roster.map((entry) => [entry.specialistId, entry]));
    let changed = false;

    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "worker" || descriptor.profileId !== profileId) {
        continue;
      }

      const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
      if (!specialistId) {
        continue;
      }

      const specialist = rosterById.get(specialistId);
      if (!specialist) {
        continue;
      }

      if (
        descriptor.specialistId === specialist.specialistId &&
        descriptor.specialistDisplayName === specialist.displayName &&
        descriptor.specialistColor === specialist.color
      ) {
        continue;
      }

      descriptor.specialistId = specialist.specialistId;
      descriptor.specialistDisplayName = specialist.displayName;
      descriptor.specialistColor = specialist.color;
      this.descriptors.set(descriptor.agentId, descriptor);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();
  }

  private async applyManagerRuntimeRecyclePolicy(
    agentId: string,
    reason:
      | "model_change"
      | "cwd_change"
      | "idle_transition"
      | "prompt_mode_change"
      | "project_agent_directory_change"
      | "specialist_roster_change"
  ): Promise<"recycled" | "deferred" | "none"> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      this.pendingManagerRuntimeRecycleAgentIds.delete(agentId);
      return "none";
    }

    if (reason === "idle_transition" && !this.pendingManagerRuntimeRecycleAgentIds.has(agentId)) {
      return "none";
    }

    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      this.pendingManagerRuntimeRecycleAgentIds.delete(agentId);
      return "none";
    }

    if (!this.canRecycleManagerRuntimeImmediately(descriptor, runtime)) {
      this.pendingManagerRuntimeRecycleAgentIds.add(agentId);
      return "deferred";
    }

    await this.recycleManagerRuntime(descriptor, runtime, reason);
    return "recycled";
  }

  private canRecycleManagerRuntimeImmediately(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime
  ): boolean {
    return (
      descriptor.role === "manager" &&
      descriptor.status === "idle" &&
      runtime.getStatus() === "idle" &&
      runtime.getPendingCount() === 0 &&
      !runtime.isContextRecoveryInProgress?.()
    );
  }

  private async recycleManagerRuntime(
    descriptor: AgentDescriptor,
    runtime: SwarmAgentRuntime,
    reason:
      | "model_change"
      | "cwd_change"
      | "idle_transition"
      | "prompt_mode_change"
      | "project_agent_directory_change"
      | "specialist_roster_change"
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const runtimeToken = this.runtimeTokensByAgentId.get(descriptor.agentId);
    this.pendingManagerRuntimeRecycleAgentIds.delete(descriptor.agentId);

    try {
      await runtime.recycle();
    } catch (error) {
      this.pendingManagerRuntimeRecycleAgentIds.add(descriptor.agentId);
      throw error;
    }

    this.detachRuntime(descriptor.agentId, runtimeToken);

    if (descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      this.descriptors.set(descriptor.agentId, descriptor);
    }

    await this.refreshSessionMetaStats(descriptor);

    this.emitStatus(descriptor.agentId, descriptor.status, 0);
    this.logDebug("manager:runtime_recycled", {
      agentId: descriptor.agentId,
      profileId: descriptor.profileId,
      reason,
      model: descriptor.model
    });
  }

  async previewManagerSystemPrompt(profileId: string): Promise<{ sections: PromptPreviewSection[] }> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const defaultDescriptor = this.descriptors.get(profile.defaultSessionAgentId);
    const descriptor =
      (this.isSessionAgent(defaultDescriptor) ? defaultDescriptor : undefined) ??
      this.getSessionsForProfile(profileId)[0];

    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    const resolvedProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? profileId;
    const { prompt: projectAgentPrompt, sourcePath: projectAgentPromptSourcePath } =
      await this.resolveProjectAgentSystemPromptOverride(descriptor);
    const archetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    const archetypeEntry = projectAgentPrompt
      ? undefined
      : await this.promptRegistry.resolveEntry("archetype", archetypeId, resolvedProfileId);
    if (!projectAgentPrompt && !archetypeEntry) {
      throw new Error(`Prompt not found: archetype/${archetypeId}`);
    }

    let systemPrompt = await this.resolveSystemPromptForDescriptor(descriptor);

    const memoryResources = await this.getMemoryRuntimeResources(descriptor);

    // Append the <available_skills> index block to the system prompt, matching
    // what the Pi agent runtime does at session startup. Skills are NOT loaded
    // in full — the agent only sees this lightweight index and reads SKILL.md
    // files on demand.
    const allSkillMetadata = this.skillMetadataService.getSkillMetadata();
    if (allSkillMetadata.length > 0) {
      const skillLines = [
        "",
        "",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>"
      ];
      for (const skill of allSkillMetadata) {
        skillLines.push("  <skill>");
        skillLines.push(`    <name>${escapeXmlForPreview(skill.skillName)}</name>`);
        if (skill.description) {
          skillLines.push(`    <description>${escapeXmlForPreview(skill.description)}</description>`);
        }
        skillLines.push(`    <location>${escapeXmlForPreview(skill.path)}</location>`);
        skillLines.push("  </skill>");
      }
      skillLines.push("</available_skills>");
      systemPrompt = systemPrompt.trimEnd() + skillLines.join("\n");
    }

    const sections: PromptPreviewSection[] = [
      {
        label: "System Prompt",
        source: projectAgentPrompt ? projectAgentPromptSourcePath! : archetypeEntry!.sourcePath,
        content: systemPrompt
      }
    ];

    sections.push({
      label: "Memory Composite",
      source: memoryResources.memoryContextFile.path,
      content: memoryResources.memoryContextFile.content
    });

    const agentsPath = join(descriptor.cwd, AGENTS_CONTEXT_FILE_NAME);
    if (existsSync(agentsPath)) {
      try {
        sections.push({
          label: AGENTS_CONTEXT_FILE_NAME,
          source: agentsPath,
          content: await readFile(agentsPath, "utf8")
        });
      } catch (error) {
        this.logDebug("prompt:preview:agents_read:error", {
          profileId: resolvedProfileId,
          path: agentsPath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const swarmContextFiles = await this.getSwarmContextFiles(descriptor.cwd);
    for (const contextFile of swarmContextFiles) {
      sections.push({
        label: SWARM_CONTEXT_FILE_NAME,
        source: contextFile.path,
        content: contextFile.content
      });
    }

    return { sections };
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
    const { descriptor, profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    const references = await listProjectAgentReferenceDocs(this.config.paths.dataDir, profileId, handle);
    const record = await readProjectAgentRecord(
      this.config.paths.dataDir,
      profileId,
      handle
    );
    if (record) {
      return { config: record.config, systemPrompt: record.systemPrompt, references };
    }
    // Fallback: construct from descriptor data (pre-migration or missing directory)
    return {
      config: {
        version: 1,
        agentId,
        handle,
        whenToUse: descriptor.projectAgent.whenToUse,
        ...(descriptor.projectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: descriptor.projectAgent.creatorSessionId }
          : {}),
        promotedAt: descriptor.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      systemPrompt: descriptor.projectAgent.systemPrompt ?? null,
      references,
    };
  }

  async listProjectAgentReferences(agentId: string): Promise<string[]> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    return listProjectAgentReferenceDocs(this.config.paths.dataDir, profileId, handle);
  }

  async getProjectAgentReference(agentId: string, fileName: string): Promise<string> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    const content = await readProjectAgentReferenceDoc(this.config.paths.dataDir, profileId, handle, fileName);
    if (content === null) {
      throw new Error(`Reference document ${fileName} does not exist`);
    }
    return content;
  }

  async setProjectAgentReference(agentId: string, fileName: string, content: string): Promise<void> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    await writeProjectAgentReferenceDoc(this.config.paths.dataDir, profileId, handle, fileName, content);
  }

  async deleteProjectAgentReference(agentId: string, fileName: string): Promise<void> {
    const { profileId, handle } = this.assertProjectAgentReferenceScope(agentId);
    await deleteProjectAgentReferenceDoc(this.config.paths.dataDir, profileId, handle, fileName);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
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
    handle?: string
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
        : {})
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
    options: { saveStore: boolean; emitSnapshots: boolean; emitStatus?: boolean; deleteWorkers?: boolean }
  ): Promise<{ terminatedWorkerIds: string[] }> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    const terminatedWorkerIds: string[] = [];
    const runtime = this.runtimes.get(agentId);
    if (
      runtime &&
      !options.deleteWorkers &&
      (descriptor.status === "streaming" || runtime.getStatus() === "streaming")
    ) {
      this.markPendingManualManagerStopNotice(agentId);
    }

    for (const workerDescriptor of this.getWorkersForManager(agentId)) {
      terminatedWorkerIds.push(workerDescriptor.agentId);
      await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true });
      if (options.deleteWorkers) {
        this.descriptors.delete(workerDescriptor.agentId);
      }
      this.conversationProjector.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
    }

    if (runtime) {
      const shutdown = await this.runRuntimeShutdown(descriptor, "terminate", { abort: true });
      this.detachRuntime(agentId, shutdown.runtimeToken);
    }
    this.pendingManagerRuntimeRecycleAgentIds.delete(agentId);

    descriptor.status = descriptor.status === "error"
      ? "idle"
      : transitionAgentStatus(descriptor.status, "idle");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(agentId, descriptor);

    if (options.emitStatus ?? true) {
      this.emitStatus(agentId, descriptor.status, 0);
    }

    await this.refreshSessionMetaStatsBySessionId(agentId);

    if (options.saveStore) {
      await this.saveStore();
    }

    if (options.emitSnapshots) {
      this.emitAgentsSnapshot();
      this.emitProfilesSnapshot();
    }

    return { terminatedWorkerIds };
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

  private async rollbackCreatedSession(descriptor: AgentDescriptor): Promise<void> {
    try {
      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        const shutdown = await this.runRuntimeShutdown(descriptor, "terminate", { abort: true });
        this.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
      }
    } catch (error) {
      this.logDebug("session:rollback:runtime_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sessionDir = getSessionDir(this.config.paths.dataDir, profileId, descriptor.agentId);
    const workersDir = getWorkersDir(this.config.paths.dataDir, profileId, descriptor.agentId);
    const canonicalSessionFile = getSessionFilePath(this.config.paths.dataDir, profileId, descriptor.agentId);
    const sessionMetaPath = getSessionMetaPath(this.config.paths.dataDir, profileId, descriptor.agentId);
    const sessionMemoryPath = resolveMemoryFilePath(this.config.paths.dataDir, {
      agentId: descriptor.agentId,
      role: "manager",
      profileId,
      managerId: descriptor.managerId
    });

    this.descriptors.delete(descriptor.agentId);
    this.pinnedMessageIdsBySessionAgentId.delete(descriptor.agentId);
    this.conversationProjector.deleteConversationHistory(descriptor.agentId, descriptor.sessionFile);

    try {
      if (descriptor.sessionFile === canonicalSessionFile) {
        await rm(sessionDir, { recursive: true, force: true });
      } else {
        await this.deleteManagerSessionFile(descriptor.sessionFile);
        await rm(sessionMemoryPath, { force: true });
        await rm(sessionMetaPath, { force: true });
        await rm(workersDir, { recursive: true, force: true });
        await rm(sessionDir, { recursive: true, force: true });
      }
    } catch (error) {
      this.logDebug("session:rollback:cleanup_error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
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
      target.projectAgent !== undefined;

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

    const isWorkerReportToManager =
      sender.role === "worker" && target.role === "manager" && sender.managerId === target.agentId;
    const watchdogTurnSeqAtDispatch = isWorkerReportToManager
      ? this.getOrCreateWorkerWatchdogState(sender.agentId).turnSeq
      : undefined;

    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );

    const senderDescriptorAfterPrep = this.descriptors.get(sender.agentId);
    const shouldTrackWorkerReportAfterPrep =
      isWorkerReportToManager &&
      watchdogTurnSeqAtDispatch !== undefined &&
      senderDescriptorAfterPrep?.role === "worker" &&
      !isNonRunningAgentStatus(senderDescriptorAfterPrep.status);

    if (isWorkerReportToManager && watchdogTurnSeqAtDispatch !== undefined) {
      const watchdogState = shouldTrackWorkerReportAfterPrep
        ? this.workerWatchdogState.get(sender.agentId)
        : undefined;
      if (watchdogState && watchdogState.turnSeq === watchdogTurnSeqAtDispatch) {
        watchdogState.pendingReportTurnSeq = watchdogTurnSeqAtDispatch;
        this.workerWatchdogState.set(sender.agentId, watchdogState);
      }
    }

    let receipt: SendMessageReceipt;
    try {
      receipt = await runtime.sendMessage(modelMessage, delivery);
    } catch (error) {
      if (isWorkerReportToManager && watchdogTurnSeqAtDispatch !== undefined) {
        const currentSender = this.descriptors.get(sender.agentId);
        const watchdogState =
          currentSender &&
          currentSender.role === "worker" &&
          !isNonRunningAgentStatus(currentSender.status)
            ? this.workerWatchdogState.get(sender.agentId)
            : undefined;
        if (watchdogState?.pendingReportTurnSeq === watchdogTurnSeqAtDispatch) {
          watchdogState.pendingReportTurnSeq = null;
          this.workerWatchdogState.set(sender.agentId, watchdogState);
          await this.finalizeDeferredWorkerIdleTurn(sender.agentId, watchdogTurnSeqAtDispatch);
        }
      }

      throw error;
    }

    if (isWorkerReportToManager && watchdogTurnSeqAtDispatch !== undefined) {
      const currentSender = this.descriptors.get(sender.agentId);
      const watchdogState =
        currentSender &&
        currentSender.role === "worker" &&
        !isNonRunningAgentStatus(currentSender.status)
          ? this.workerWatchdogState.get(sender.agentId)
          : undefined;
      if (watchdogState?.pendingReportTurnSeq === watchdogTurnSeqAtDispatch) {
        watchdogState.pendingReportTurnSeq = null;
      }
      if (watchdogState && watchdogState.turnSeq === watchdogTurnSeqAtDispatch) {
        watchdogState.reportedThisTurn = true;
        watchdogState.consecutiveNotifications = 0;
        watchdogState.suppressedUntilMs = 0;
        watchdogState.circuitOpen = false;
      }
      if (watchdogState) {
        this.workerWatchdogState.set(sender.agentId, watchdogState);
        await this.finalizeDeferredWorkerIdleTurn(sender.agentId, watchdogTurnSeqAtDispatch);
      }
    }

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
      const newCount = await incrementSessionCompactionCount(
        this.config.paths.dataDir,
        descriptor.profileId!,
        agentId
      ).catch((err) => {
        this.logDebug("manager:compact:count-increment-failed", { agentId, error: String(err) });
        return undefined;
      });
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
        const smartCount = await incrementSessionCompactionCount(
          this.config.paths.dataDir,
          descriptor.profileId!,
          agentId
        ).catch((err) => {
          this.logDebug("manager:smart_compact:count-increment-failed", { agentId, error: String(err) });
          return undefined;
        });
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
    if (!this.config.cortexEnabled) {
      return false;
    }

    if (!this.isCortexRootInteractiveSession(target)) {
      return false;
    }

    const scheduledEnvelope = parseScheduledTaskEnvelope(text);
    const reviewText = scheduledEnvelope?.body ?? text;
    const scope = parseCortexReviewRunScopeFromText(reviewText);
    if (!scope) {
      return false;
    }

    const trigger: CortexReviewRunTrigger = scheduledEnvelope ? "scheduled" : "manual";
    if (trigger === "scheduled" && scope.mode === "all") {
      const scanResult = await scanCortexReviewStatus(this.config.paths.dataDir);
      if (scanResult.summary.needsReview === 0) {
        this.logDebug("cortex:auto_review:skipped", {
          reason: "nothing needs review",
          upToDate: scanResult.summary.upToDate,
          excluded: scanResult.summary.excluded,
          scheduleName: scheduledEnvelope?.scheduleName ?? null
        });
        return true;
      }
    }

    await this.startCortexReviewRun({
      scope,
      trigger,
      sourceContext,
      requestText: text.trim(),
      scheduleName: scheduledEnvelope?.scheduleName ?? null
    });
    return true;
  }

  private isCortexRootInteractiveSession(descriptor: AgentDescriptor): boolean {
    return (
      descriptor.role === "manager" &&
      descriptor.agentId === CORTEX_PROFILE_ID &&
      descriptor.profileId === CORTEX_PROFILE_ID &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID &&
      descriptor.sessionPurpose !== "cortex_review" &&
      descriptor.sessionPurpose !== "agent_creator"
    );
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
    return Array.from(this.runtimeExtensionSnapshotsByAgentId.values())
      .map((snapshot) => ({
        ...snapshot,
        extensions: snapshot.extensions.map((extension) => ({
          ...extension,
          events: [...extension.events],
          tools: [...extension.tools]
        })),
        loadErrors: snapshot.loadErrors.map((error) => ({ ...error }))
      }))
      .sort(compareRuntimeExtensionSnapshots);
  }

  setIntegrationContextProvider(provider?: (profileId: string) => string): void {
    this.integrationContextProvider = provider;
  }

  async buildForgeExtensionSettingsSnapshot(options: { cwdValues: string[] }) {
    return this.forgeExtensionHost.buildSettingsSnapshot(options);
  }

  async dispatchForgeVersioningCommit(event: ForgeVersioningCommitEvent): Promise<void> {
    await this.forgeExtensionHost.dispatchVersioningCommit(event);
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.secretsEnvService.listSettingsEnv();
  }

  async listSkillMetadata(profileId?: string): Promise<
    Array<{
      skillId: string;
      name: string;
      directoryName: string;
      description?: string;
      envCount: number;
      hasRichConfig: boolean;
      sourceKind: "builtin" | "repo" | "machine-local" | "profile";
      profileId?: string;
      rootPath: string;
      skillFilePath: string;
      isInherited: boolean;
      isEffective: boolean;
    }>
  > {
    await this.skillMetadataService.reloadSkillMetadata();

    let metadata;
    if (typeof profileId === "string") {
      metadata = await this.skillMetadataService.getProfileSkillMetadata(profileId);
    } else {
      metadata = this.skillMetadataService.getSkillMetadata();
    }

    return metadata
      .map((metadata) => ({
        skillId: metadata.skillId,
        name: metadata.skillName,
        directoryName: metadata.directoryName,
        description: metadata.description,
        envCount: metadata.env.length,
        hasRichConfig: metadata.directoryName.trim().toLowerCase() === "chrome-cdp",
        sourceKind: metadata.sourceKind,
        ...(metadata.profileId ? { profileId: metadata.profileId } : {}),
        rootPath: metadata.rootPath,
        skillFilePath: metadata.path,
        isInherited: metadata.isInherited,
        isEffective: metadata.isEffective
      }))
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        if (byName !== 0) {
          return byName;
        }

        return left.directoryName.localeCompare(right.directoryName);
      });
  }

  async listSkillFiles(skillId: string, relativePath = ""): Promise<{
    skillId: string;
    rootPath: string;
    path: string;
    entries: Array<{
      name: string;
      path: string;
      absolutePath: string;
      type: "file" | "directory";
      size?: number;
      extension?: string;
    }>;
  }> {
    const skill = await this.skillMetadataService.resolveSkillById(skillId);
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.skillFileService.listDirectory(skill, relativePath);
  }

  async getSkillFileContent(skillId: string, relativePath: string): Promise<{
    path: string;
    absolutePath: string;
    content: string | null;
    binary: boolean;
    size: number;
    lines?: number;
  }> {
    const skill = await this.skillMetadataService.resolveSkillById(skillId);
    if (!skill) {
      throw new Error("Unknown skill.");
    }

    return this.skillFileService.getFileContent(skill, relativePath);
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    await this.secretsEnvService.updateSettingsEnv(values);
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    await this.secretsEnvService.deleteSettingsEnv(name);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    return this.secretsEnvService.listSettingsAuth();
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    await this.secretsEnvService.updateSettingsAuth(values);
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    await this.secretsEnvService.deleteSettingsAuth(provider);
  }

  // ── Credential Pool pass-through ──

  getCredentialPoolService(): CredentialPoolService {
    return this.secretsEnvService.getCredentialPoolService();
  }

  async listCredentialPool(provider: string): Promise<CredentialPoolState> {
    return this.secretsEnvService.getCredentialPoolService().listPool(provider);
  }

  async renamePooledCredential(provider: string, credentialId: string, label: string): Promise<void> {
    await this.secretsEnvService.getCredentialPoolService().renameCredential(provider, credentialId, label);
  }

  async removePooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.secretsEnvService.getCredentialPoolService().removeCredential(provider, credentialId);
  }

  async setPrimaryPooledCredential(provider: string, credentialId: string): Promise<void> {
    await this.secretsEnvService.getCredentialPoolService().setPrimary(provider, credentialId);
  }

  async setCredentialPoolStrategy(provider: string, strategy: CredentialPoolStrategy): Promise<void> {
    await this.secretsEnvService.getCredentialPoolService().setStrategy(provider, strategy);
  }

  async resetPooledCredentialCooldown(provider: string, credentialId: string): Promise<void> {
    await this.secretsEnvService.getCredentialPoolService().resetCooldown(provider, credentialId);
  }

  async addPooledCredential(
    provider: string,
    oauthCredential: AuthCredential,
    identity?: { label?: string; autoLabel?: string; accountId?: string }
  ): Promise<PooledCredentialInfo> {
    return this.secretsEnvService.getCredentialPoolService().addCredential(provider, oauthCredential, identity);
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

    await this.ensureProfileDirectories(profile.profileId);
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
    return descriptor.status === "streaming";
  }

  private async getOrCreateRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    const inFlightCreation = this.runtimeCreationPromisesByAgentId.get(descriptor.agentId);
    if (inFlightCreation) {
      return inFlightCreation;
    }

    const existingRuntime = this.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const creationPromise = this.createAndAttachRuntimeForDescriptor(descriptor);
    this.runtimeCreationPromisesByAgentId.set(descriptor.agentId, creationPromise);

    try {
      return await creationPromise;
    } finally {
      if (this.runtimeCreationPromisesByAgentId.get(descriptor.agentId) === creationPromise) {
        this.runtimeCreationPromisesByAgentId.delete(descriptor.agentId);
      }
    }
  }

  private async createAndAttachRuntimeForDescriptor(descriptor: AgentDescriptor): Promise<SwarmAgentRuntime> {
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);

    const existingRuntime = this.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    const systemPrompt = await this.resolveSystemPromptForDescriptor(descriptor);
    const runtimeBeforeCreate = this.runtimes.get(descriptor.agentId);
    if (runtimeBeforeCreate) {
      return runtimeBeforeCreate;
    }

    const runtimeToken = this.allocateRuntimeToken(descriptor.agentId);
    const runtime = await this.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
    if (descriptor.role === "manager") {
      await this.syncPinnedContentForManagerRuntime(descriptor as AgentDescriptor & { role: "manager" }, { runtime });
    }
    const persistedSystemPrompt = runtime.getSystemPrompt?.() ?? systemPrompt;

    const latestDescriptor = this.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
        drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
        drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      return concurrentRuntime;
    }

    this.runtimes.set(descriptor.agentId, runtime);
    if (latestDescriptor.role === "worker") {
      this.seedWorkerCompletionReportTimestamp(latestDescriptor.agentId);
    }

    const contextUsage = runtime.getContextUsage();
    latestDescriptor.contextUsage = contextUsage;
    this.descriptors.set(descriptor.agentId, latestDescriptor);

    if (latestDescriptor.role === "manager") {
      await this.captureSessionRuntimePromptMeta(latestDescriptor, persistedSystemPrompt);
      await this.refreshSessionMetaStats(latestDescriptor);
    } else {
      await this.updateSessionMetaForWorkerDescriptor(latestDescriptor, persistedSystemPrompt);
      await this.refreshSessionMetaStatsBySessionId(latestDescriptor.managerId);
    }

    this.emitStatus(descriptor.agentId, latestDescriptor.status, runtime.getPendingCount(), contextUsage);
    return runtime;
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

  private normalizePersistedModelDescriptor(
    descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
  ): AgentModelDescriptor {
    return normalizeSwarmModelDescriptor(descriptor, this.defaultModelPreset);
  }

  private resolveSpawnModel(input: SpawnAgentInput, fallback: AgentModelDescriptor): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(input.model, "spawn_agent.model");
    const requestedReasoningLevel = parseSwarmReasoningLevel(
      input.reasoningLevel,
      "spawn_agent.reasoningLevel"
    );

    const descriptor = requestedPreset
      ? resolveModelDescriptorFromPreset(requestedPreset)
      : this.normalizePersistedModelDescriptor(fallback);

    const requestedModelId = normalizeOptionalModelId(input.modelId);
    if (requestedModelId) {
      descriptor.modelId = requestedModelId;
    }

    if (requestedReasoningLevel) {
      descriptor.thinkingLevel = requestedReasoningLevel;
    }

    descriptor.thinkingLevel = normalizeThinkingLevelForProvider(
      descriptor.provider,
      descriptor.thinkingLevel
    );

    return descriptor;
  }

  private resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor {
    const provider = normalizeOptionalAgentId(model.provider)?.toLowerCase();
    const requestedModelId = normalizeOptionalModelId(model.modelId)?.toLowerCase();
    if (!provider || !requestedModelId) {
      return model;
    }

    const requestedBlock = this.getActiveModelCapacityBlock(provider, requestedModelId);
    if (!requestedBlock) {
      return model;
    }

    const attemptedModelIds: string[] = [requestedModelId];
    let candidateModelId = requestedModelId;

    while (true) {
      const nextModelId = resolveNextCapacityFallbackModelId(provider, candidateModelId);
      if (!nextModelId) {
        this.logDebug("agent:spawn:model_blocked_no_fallback", {
          provider,
          requestedModelId,
          blockedUntil: new Date(requestedBlock.blockedUntilMs).toISOString(),
          attemptedModelIds
        });
        return model;
      }

      attemptedModelIds.push(nextModelId);

      const nextBlock = this.getActiveModelCapacityBlock(provider, nextModelId);
      if (!nextBlock) {
        this.logDebug("agent:spawn:model_reroute", {
          provider,
          requestedModelId,
          selectedModelId: nextModelId,
          attemptedModelIds
        });
        return {
          ...model,
          modelId: nextModelId
        };
      }

      candidateModelId = nextModelId;
    }
  }

  private getActiveModelCapacityBlock(provider: string, modelId: string): ModelCapacityBlock | undefined {
    const key = buildModelCapacityBlockKey(provider, modelId);
    if (!key) {
      return undefined;
    }

    const block = this.modelCapacityBlocks.get(key);
    if (!block) {
      return undefined;
    }

    if (Date.now() >= block.blockedUntilMs) {
      this.modelCapacityBlocks.delete(key);
      this.logDebug("model_capacity:block_expired", {
        provider: block.provider,
        modelId: block.modelId,
        blockedUntil: new Date(block.blockedUntilMs).toISOString()
      });
      return undefined;
    }

    return block;
  }

  private maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void {
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

  private buildStandardPromptVariables(descriptor: AgentDescriptor): Record<string, string> {
    return {
      SWARM_DATA_DIR: this.config.paths.dataDir,
      SWARM_MEMORY_FILE: this.getAgentMemoryPath(descriptor.agentId),
      SWARM_SCRIPTS_DIR: join(this.config.paths.rootDir, "apps", "backend", "src", "swarm", "scripts")
    };
  }

  private async resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    if (options?.ignoreProjectAgentSystemPrompt || !descriptor.projectAgent?.handle) {
      return {
        prompt: undefined,
        sourcePath: undefined
      };
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sourcePath = getProjectAgentPromptPath(this.config.paths.dataDir, profileId, descriptor.projectAgent.handle);
    const onDiskRecord = await readProjectAgentRecord(
      this.config.paths.dataDir,
      profileId,
      descriptor.projectAgent.handle
    );
    let prompt: string | undefined;
    if (onDiskRecord?.systemPrompt !== null && onDiskRecord?.systemPrompt !== undefined) {
      prompt = onDiskRecord.systemPrompt.trim() || undefined;
    } else {
      prompt = descriptor.projectAgent.systemPrompt?.trim() || undefined;
    }

    return {
      prompt,
      sourcePath: prompt ? sourcePath : undefined
    };
  }

  private assertProjectAgentReferenceScope(agentId: string): {
    descriptor: AgentDescriptor & { projectAgent: NonNullable<AgentDescriptor["projectAgent"]> };
    profileId: string;
    handle: string;
  } {
    const descriptor = this.descriptors.get(agentId);
    const handle = descriptor?.projectAgent?.handle?.trim();
    if (!descriptor?.projectAgent || !handle) {
      throw new Error(`Agent ${agentId} is not a project agent`);
    }

    return {
      descriptor: descriptor as AgentDescriptor & { projectAgent: NonNullable<AgentDescriptor["projectAgent"]> },
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle
    };
  }

  private async buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean }
  ): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const managerArchetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;

    const specialistRegistry = await this.loadSpecialistRegistryModule();
    const { prompt: projectAgentPrompt } = await this.resolveProjectAgentSystemPromptOverride(descriptor, options);
    const [promptTemplate, roster, specialistsEnabled] = await Promise.all([
      projectAgentPrompt
        ? Promise.resolve(projectAgentPrompt)
        : this.promptRegistry.resolve("archetype", managerArchetypeId, profileId),
      specialistRegistry.resolveRoster(profileId),
      specialistRegistry.getSpecialistsEnabled(),
    ]);

    const delegationBlock = specialistsEnabled
      ? specialistRegistry.generateRosterBlock(roster)
      : specialistRegistry.legacyModelRoutingGuidance;
    const projectAgentDirectoryBlock = generateProjectAgentDirectoryBlock(
      listProjectAgents(this.descriptors.values(), profileId, { excludeAgentId: descriptor.agentId }).map((entry) => ({
        agentId: entry.agentId,
        displayName: getProjectAgentPublicName(entry),
        handle: entry.projectAgent.handle,
        whenToUse: entry.projectAgent.whenToUse
      }))
    );
    const delegationContextBlock = `${delegationBlock}\n\n${projectAgentDirectoryBlock}`;
    let prompt = resolvePromptVariables(promptTemplate, this.buildStandardPromptVariables(descriptor));

    if (descriptor.projectAgent?.handle) {
      const refDocFiles = await listProjectAgentReferenceDocs(
        this.config.paths.dataDir,
        profileId,
        descriptor.projectAgent.handle
      );
      if (refDocFiles.length > 0) {
        const refContents: string[] = [];
        for (const fileName of refDocFiles) {
          const content = await readProjectAgentReferenceDoc(
            this.config.paths.dataDir,
            profileId,
            descriptor.projectAgent.handle,
            fileName
          );
          if (content) {
            refContents.push(`## ${fileName}\n${content}`);
          }
        }
        if (refContents.length > 0) {
          prompt = `${prompt.trimEnd()}\n\n<agent_reference_docs>\n${refContents.join("\n\n")}\n</agent_reference_docs>`;
        }
      }
    }

    if (prompt.includes("${SPECIALIST_ROSTER}")) {
      prompt = prompt.replaceAll("${SPECIALIST_ROSTER}", delegationContextBlock);
    } else {
      prompt = `${prompt.trimEnd()}\n\n${delegationContextBlock}`;
    }

    const modelSpecificInstructionsPlaceholders = [
      "${MODEL_SPECIFIC_INSTRUCTIONS}",
      "${Model_Specific_Instructions}",
      "${model_specific_instructions}",
    ];
    if (modelSpecificInstructionsPlaceholders.some((placeholder) => prompt.includes(placeholder))) {
      const effectiveModelSpecificInstructions = modelCatalogService.getEffectiveModelSpecificInstructions(
        descriptor.model.modelId,
        descriptor.model.provider
      );
      const modelSpecificInstructionsBlock = effectiveModelSpecificInstructions
        ? `# Model-Specific Instructions\n${effectiveModelSpecificInstructions}`
        : "";
      for (const placeholder of modelSpecificInstructionsPlaceholders) {
        prompt = prompt.replaceAll(placeholder, modelSpecificInstructionsBlock);
      }
    }

    if (this.integrationContextProvider) {
      try {
        const integrationContext = this.integrationContextProvider(profileId).trim();
        if (integrationContext) {
          prompt = `${prompt}\n\n${integrationContext}`;
        }
      } catch (error) {
        this.logDebug("manager:integration_context:error", {
          agentId: descriptor.agentId,
          profileId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return prompt;
  }

  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;

    if (descriptor.role === "manager") {
      return this.buildResolvedManagerPrompt(descriptor);
    }

    const specialistId = normalizeOptionalAgentId(
      descriptor.specialistId
    )?.toLowerCase();
    if (specialistId) {
      try {
        const roster = await this.resolveSpecialistRosterForProfile(profileId);
        const specialist = roster.find((entry) => entry.specialistId === specialistId);
        const specialistPrompt = specialist?.promptBody?.trim();
        if (specialistPrompt) {
          return specialistPrompt;
        }
      } catch (error) {
        this.logDebug("specialist:resolve:error", {
          agentId: descriptor.agentId,
          profileId,
          specialistId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (descriptor.archetypeId) {
      const normalizedArchetypeId = normalizeArchetypeId(descriptor.archetypeId);
      if (normalizedArchetypeId) {
        const archetypePrompt = await this.promptRegistry.resolveEntry("archetype", normalizedArchetypeId, profileId);
        if (archetypePrompt) {
          return archetypePrompt.content;
        }
      }
    }

    try {
      return await this.promptRegistry.resolve("archetype", "worker", profileId);
    } catch (error) {
      this.logDebug("prompt:resolve:fallback", {
        category: "archetype",
        promptId: "worker",
        profileId,
        message: error instanceof Error ? error.message : String(error)
      });
      return DEFAULT_WORKER_SYSTEM_PROMPT;
    }
  }

  private injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    if (descriptor.role !== "worker") {
      return systemPrompt;
    }

    const identityBlock = [
      "",
      "# Agent Identity",
      `- Your agent ID: \`${descriptor.agentId}\``,
      `- Your manager ID: \`${descriptor.managerId}\``,
      "- Always use your manager ID above when sending messages back via send_message_to_agent.",
      "- Do NOT guess the manager ID from list_agents — use the ID provided here."
    ].join("\n");

    return systemPrompt + identityBlock;
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

  private assertCortexRootInteractiveManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.assertManager(agentId, action);
    if (!this.isCortexRootInteractiveSession(descriptor)) {
      throw new Error(`Only the root interactive Cortex session can ${action}`);
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
    this.cancelAllPendingChoicesForAgent(descriptor.agentId);

    if (descriptor.role === "worker") {
      this.clearWatchdogState(descriptor.agentId);
      this.workerStallState.delete(descriptor.agentId);
      this.workerActivityState.delete(descriptor.agentId);
      this.lastWorkerCompletionReportTimestampByAgentId.delete(descriptor.agentId);
      this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(descriptor.agentId);
    }

    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      const shutdown = await this.runRuntimeShutdown(descriptor, "terminate", { abort: options.abort });
      this.detachRuntime(descriptor.agentId, shutdown.runtimeToken);
    }
    this.pendingManagerRuntimeRecycleAgentIds.delete(descriptor.agentId);

    descriptor.status = transitionAgentStatus(descriptor.status, "terminated");
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(descriptor.agentId, descriptor);

    if (descriptor.role === "worker") {
      await this.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else {
      await this.refreshSessionMetaStats(descriptor);
    }

    if (options.emitStatus) {
      this.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId);

    const memoryOwnerDescriptor = this.descriptors.get(memoryOwnerAgentId);
    if (memoryOwnerDescriptor?.role === "manager") {
      await this.ensureAgentMemoryFile(
        memoryFilePath,
        normalizeOptionalAgentId(memoryOwnerDescriptor.profileId) ?? memoryOwnerDescriptor.agentId
      );
    }

    const sessionMemoryContent = await readFile(memoryFilePath, "utf8");
    let memoryContent = sessionMemoryContent;

    const profileMemoryOwnerId = this.resolveSessionProfileId(memoryOwnerAgentId);
    if (profileMemoryOwnerId) {
      const profileMemoryPath = getProfileMemoryPath(this.config.paths.dataDir, profileMemoryOwnerId);
      await this.ensureAgentMemoryFile(profileMemoryPath, profileMemoryOwnerId);
      const profileMemoryContent = await readFile(profileMemoryPath, "utf8");
      memoryContent = buildSessionMemoryRuntimeView(profileMemoryContent, sessionMemoryContent);
    }

    const commonKnowledgePath = getCommonKnowledgePath(this.config.paths.dataDir);
    try {
      const commonKnowledgeContent = (await readFile(commonKnowledgePath, "utf8")).trim();
      if (commonKnowledgeContent.length > 0) {
        const baseMemoryContent = memoryContent.trimEnd();
        memoryContent = [
          baseMemoryContent,
          "",
          "---",
          "",
          COMMON_KNOWLEDGE_MEMORY_HEADER,
          "",
          commonKnowledgeContent
        ].join("\n");
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    if (
      descriptor.role === "manager" &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID
    ) {
      const onboardingSnapshot = await getOnboardingSnapshot(this.config.paths.dataDir);
      if (shouldInjectOnboardingSnapshot(onboardingSnapshot)) {
        memoryContent = [
          memoryContent.trimEnd(),
          "",
          "---",
          "",
          buildOnboardingSnapshotMemoryBlock(onboardingSnapshot).trimEnd()
        ].join("\n");
      }
    }

    await this.skillMetadataService.ensureSkillMetadataLoaded();

    if (descriptor.role === "manager") {
      await this.refreshSessionMetaStats(descriptor);
    } else {
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    }

    return {
      memoryContextFile: {
        path: memoryFilePath,
        content: memoryContent
      },
      additionalSkillPaths: this.skillMetadataService.getAdditionalSkillPaths()
    };
  }

  private async reloadSkillMetadata(): Promise<void> {
    await this.skillMetadataService.reloadSkillMetadata();
  }

  private async loadSecretsStore(): Promise<void> {
    await this.secretsEnvService.loadSecretsStore();
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8")
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId)
  ): Promise<SwarmAgentRuntime> {
    try {
      return await this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken);
    } catch (error) {
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw error;
    }
  }

  private allocateRuntimeToken(agentId: string): number {
    const token = this.nextRuntimeToken;
    this.nextRuntimeToken += 1;
    this.runtimeTokensByAgentId.set(agentId, token);
    return token;
  }

  private isCurrentRuntimeToken(agentId: string, runtimeToken: number): boolean {
    return this.runtimeTokensByAgentId.get(agentId) === runtimeToken;
  }

  private getSuppressedSpecialistFallbackHandoff(
    agentId: string,
    runtimeToken?: number
  ): SpecialistFallbackHandoffState | undefined {
    if (runtimeToken === undefined) {
      return undefined;
    }

    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (handoff?.suppressedRuntimeToken === runtimeToken) {
      return handoff;
    }

    return undefined;
  }

  private shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken)) {
      return true;
    }

    return !this.isCurrentRuntimeToken(agentId, runtimeToken);
  }

  private beginSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken: number): void {
    this.specialistFallbackHandoffsByAgentId.set(agentId, {
      suppressedRuntimeToken,
      startedAt: this.now()
    });
  }

  private bufferSpecialistFallbackStatusDuringHandoff(
    agentId: string,
    runtimeToken: number,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.bufferedStatus = {
      status,
      pendingCount,
      contextUsage: normalizeContextUsage(contextUsage)
    };
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  private bufferSpecialistFallbackAgentEndDuringHandoff(agentId: string, runtimeToken: number): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.receivedAgentEnd = true;
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  private endSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (!handoff) {
      return;
    }

    if (suppressedRuntimeToken !== undefined && handoff.suppressedRuntimeToken !== suppressedRuntimeToken) {
      return;
    }

    this.specialistFallbackHandoffsByAgentId.delete(agentId);
  }

  private async reconcileBufferedSpecialistFallbackCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined
  ): Promise<void> {
    if (suppressedRuntimeToken === undefined) {
      return;
    }

    const handoffState = this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    if (!handoffState) {
      return;
    }

    if (handoffState.bufferedStatus) {
      await this.handleRuntimeStatus(
        suppressedRuntimeToken,
        agentId,
        handoffState.bufferedStatus.status,
        handoffState.bufferedStatus.pendingCount,
        handoffState.bufferedStatus.contextUsage
      );
    }

    if (handoffState.receivedAgentEnd) {
      await this.handleRuntimeAgentEnd(suppressedRuntimeToken, agentId);
    }
  }

  private clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    const isCurrentRuntime = runtimeToken === undefined || this.isCurrentRuntimeToken(agentId, runtimeToken);

    if (runtimeToken !== undefined) {
      this.forgeExtensionHost.deactivateRuntimeBindings(createForgeBindingToken(runtimeToken));
    }

    if (!isCurrentRuntime) {
      return;
    }

    this.runtimeTokensByAgentId.delete(agentId);
    this.runtimeExtensionSnapshotsByAgentId.delete(agentId);
  }

  private handleRuntimeExtensionSnapshot(
    runtimeToken: number,
    agentId: string,
    snapshot: AgentRuntimeExtensionSnapshot
  ): void {
    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.runtimeExtensionSnapshotsByAgentId.set(agentId, {
      ...snapshot,
      extensions: snapshot.extensions.map((extension) => ({
        ...extension,
        events: [...extension.events],
        tools: [...extension.tools]
      })),
      loadErrors: snapshot.loadErrors.map((error) => ({ ...error }))
    });
  }

  private detachRuntime(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken !== undefined && !this.isCurrentRuntimeToken(agentId, runtimeToken)) {
      this.clearRuntimeToken(agentId, runtimeToken);
      return false;
    }

    this.runtimes.delete(agentId);
    this.clearRuntimeToken(agentId, runtimeToken);
    return true;
  }

  private async runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (!runtime) {
      return { timedOut: false, runtimeToken: undefined };
    }

    const runtimeToken = this.runtimeTokensByAgentId.get(descriptor.agentId);
    const operation =
      action === "terminate"
        ? runtime.terminate({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          })
        : runtime.stopInFlight({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          });

    try {
      await withManagerTimeout(
        operation,
        options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
        `${action}:${descriptor.agentId}`
      );
      return { timedOut: false, runtimeToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/i.test(message);
      if (timedOut) {
        this.logDebug("runtime:shutdown:timeout", {
          agentId: descriptor.agentId,
          action,
          timeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
          message,
        });
        void operation.catch((lateError) => {
          this.logDebug("runtime:shutdown:late_completion", {
            agentId: descriptor.agentId,
            action,
            message: lateError instanceof Error ? lateError.message : String(lateError),
          });
        });
        this.detachRuntime(descriptor.agentId, runtimeToken);
        return { timedOut: true, runtimeToken };
      }

      throw error;
    }
  }

  private async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    if (this.bufferSpecialistFallbackStatusDuringHandoff(agentId, runtimeToken, status, pendingCount, contextUsage)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    const contextUsageChanged = !areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage);
    let shouldPersist = false;

    if (contextUsageChanged) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    const previousStatus = descriptor.status;
    const nextStatus = transitionAgentStatus(previousStatus, status);
    const statusChanged = previousStatus !== nextStatus;
    if (statusChanged) {
      descriptor.status = nextStatus;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
    }

    if (previousStatus !== "streaming" && nextStatus === "streaming") {
      descriptor.streamingStartedAt = Date.now();
      shouldPersist = true;
    }

    // NOTE: The Pi/Anthropic runtime directly mutates descriptor.status before calling
    // this callback, so previousStatus/nextStatus may both be the target status already.
    // We use idempotent presence checks instead of transition detection.
    if (descriptor.role === "worker") {
      const effectiveStatus = descriptor.status;
      if (effectiveStatus === "streaming" && !this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      } else if (effectiveStatus !== "streaming" && this.workerStallState.has(agentId)) {
        this.workerStallState.delete(agentId);
        this.workerActivityState.delete(agentId);
      }
    }

    if (isNonRunningAgentStatus(nextStatus) && descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      shouldPersist = true;
    }

    this.descriptors.set(agentId, descriptor);

    if (descriptor.role === "worker" && (statusChanged || contextUsageChanged || nextStatus === "terminated")) {
      await this.updateSessionMetaForWorkerDescriptor(descriptor);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    } else if (descriptor.role === "manager" && statusChanged) {
      await this.refreshSessionMetaStats(descriptor);
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount, descriptor.contextUsage);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: descriptor.contextUsage
    });

    if (descriptor.role === "worker") {
      if (nextStatus === "streaming") {
        const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
        watchdogState.hadStreamingThisTurn = true;
        this.workerWatchdogState.set(agentId, watchdogState);
        this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
        this.clearWatchdogTimer(agentId);
        this.removeWorkerFromWatchdogBatchQueues(agentId);
      } else if (nextStatus === "idle" && pendingCount === 0) {
        const watchdogState = this.workerWatchdogState.get(agentId);
        if (watchdogState?.hadStreamingThisTurn) {
          await this.finalizeWorkerIdleTurn(agentId, descriptor, "status_idle");
        }
      }
    }

    if (descriptor.role === "manager") {
      if (nextStatus === "idle" && pendingCount === 0) {
        this.scheduleCortexCloseoutReminder(descriptor.agentId);
        const recycleDisposition = await this.applyManagerRuntimeRecyclePolicy(descriptor.agentId, "idle_transition");
        if (recycleDisposition === "recycled") {
          await this.saveStore();
          this.emitAgentsSnapshot();
        }
      } else {
        this.clearCortexCloseoutReminder(descriptor.agentId);
      }
    }
  }

  private scheduleCortexCloseoutReminder(agentId: string): void {
    this.clearCortexCloseoutReminder(agentId);

    const timer = setTimeout(() => {
      this.cortexCloseoutReminderTimersByAgentId.delete(agentId);
      void this.maybeRemindCortexCloseout(agentId);
    }, 250);

    this.cortexCloseoutReminderTimersByAgentId.set(agentId, timer);
  }

  private clearCortexCloseoutReminder(agentId: string): void {
    const timer = this.cortexCloseoutReminderTimersByAgentId.get(agentId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.cortexCloseoutReminderTimersByAgentId.delete(agentId);
  }

  private async maybeRemindCortexCloseout(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }
    if (normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID) {
      return;
    }
    if (descriptor.status !== "idle") {
      return;
    }

    const runtime = this.runtimes.get(agentId);
    if (runtime && runtime.getPendingCount() > 0) {
      return;
    }

    const analysis = analyzeLatestCortexCloseoutNeed(this.getConversationHistory(descriptor.agentId));
    if (!analysis.needsReminder || typeof analysis.userTimestamp !== "number") {
      return;
    }

    if (this.lastCortexCloseoutReminderUserTimestampByAgentId.get(descriptor.agentId) === analysis.userTimestamp) {
      return;
    }

    try {
      await this.sendMessage(descriptor.agentId, descriptor.agentId, CORTEX_USER_CLOSEOUT_REMINDER_MESSAGE, "auto", {
        origin: "internal"
      });
      this.lastCortexCloseoutReminderUserTimestampByAgentId.set(descriptor.agentId, analysis.userTimestamp);
      this.logDebug("cortex:closeout_reminder:sent", {
        agentId: descriptor.agentId,
        userTimestamp: analysis.userTimestamp,
        reason: analysis.reason
      });
    } catch (error) {
      this.logDebug("cortex:closeout_reminder:error", {
        agentId: descriptor.agentId,
        userTimestamp: analysis.userTimestamp,
        reason: analysis.reason,
        message: error instanceof Error ? error.message : String(error)
      });
    }
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

  private consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean {
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

  private stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent {
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

  private async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrEvent as string)
      : runtimeTokenOrAgentId;
    const event = invokedWithExplicitToken ? maybeEvent : (agentIdOrEvent as RuntimeSessionEvent);

    if (!event) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    if (
      descriptor?.role === "worker" &&
      event.type === "message_end" &&
      extractMessageStopReason(event.message) === "error"
    ) {
      const errorText =
        extractMessageErrorMessage(event.message) ??
        extractMessageText(event.message) ??
        "Unknown runtime error";
      this.maybeRecordModelCapacityBlock(agentId, descriptor, {
        phase: "prompt_start",
        message: errorText
      });

      const recoveredWithFallback = await this.maybeRecoverWorkerWithSpecialistFallback(
        agentId,
        errorText,
        "prompt_start",
        runtimeToken
      );
      if (recoveredWithFallback) {
        return;
      }
    }

    const shouldSurfaceManualStopNotice =
      descriptor?.role === "manager" && this.consumePendingManualManagerStopNoticeIfApplicable(agentId, event);
    const effectiveEvent = shouldSurfaceManualStopNotice ? this.stripManagerAbortErrorFromEvent(event) : event;

    this.captureConversationEventFromRuntime(agentId, effectiveEvent);
    if (shouldSurfaceManualStopNotice) {
      this.conversationProjector.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: MANUAL_MANAGER_STOP_NOTICE,
        timestamp: this.now(),
        source: "system"
      });
    }
    this.maybeRecordVersionedToolMutation(agentId, effectiveEvent);

    if (descriptor?.role === "worker") {
      this.trackWorkerStallProgressEvent(descriptor.agentId, effectiveEvent);
      this.updateWorkerActivity(descriptor.agentId, effectiveEvent);
    }

    if (!this.config.debug) return;

    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (effectiveEvent.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: effectiveEvent.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          args: previewForLog(safeJson(effectiveEvent.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          isError: effectiveEvent.isError,
          result: previewForLog(safeJson(effectiveEvent.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${effectiveEvent.type}`, {
          role: extractRole(effectiveEvent.message),
          textPreview: previewForLog(extractMessageText(effectiveEvent.message) ?? "")
        });
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private trackWorkerStallProgressEvent(agentId: string, event: RuntimeSessionEvent): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start": {
        stallState.lastToolName = event.toolName;
        stallState.lastToolInput = trimToMaxChars(formatToolExecutionPayload(event.args), 500);
        stallState.lastToolOutput = null;
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_update": {
        stallState.lastToolName = event.toolName;
        const chunk = formatToolExecutionPayload(event.partialResult);
        const mergedOutput = `${stallState.lastToolOutput ?? ""}${chunk}`;
        stallState.lastToolOutput = trimToMaxCharsFromEnd(mergedOutput, 500);
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_end":
      case "turn_end":
        this.recordWorkerStallProgress(agentId);
        return;

      case "message_update":
      case "message_end": {
        const role = extractRole(event.message);
        if (role === "assistant" || role === "system") {
          this.recordWorkerStallProgress(agentId);
        }
        return;
      }

      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        // Context recovery is legitimate system activity — fully reset stall tracking
        // including nudge state. Without this, a nudge sent before context recovery
        // could trigger a false auto-kill immediately after recovery ends, because the
        // kill threshold is measured from nudgeSentAt (which may be stale).
        this.recordWorkerStallProgress(agentId);
        return;

      default:
        return;
    }
  }

  private updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    // Activity metrics are only meaningful while stall state exists (active streaming).
    // Late runtime events can arrive after idle transitions; ignore those and avoid
    // recreating stale activity entries.
    if (!this.workerStallState.has(agentId)) {
      this.workerActivityState.delete(agentId);
      return;
    }

    let state = this.workerActivityState.get(agentId);
    if (!state) {
      state = {
        currentToolName: null,
        currentToolStartedAt: null,
        lastProgressAt: Date.now(),
        toolCallCount: 0,
        errorCount: 0,
        turnCount: 0
      };
      this.workerActivityState.set(agentId, state);
    }

    switch (event.type) {
      case "tool_execution_start":
        state.currentToolName = event.toolName;
        state.currentToolStartedAt = Date.now();
        state.toolCallCount++;
        state.lastProgressAt = Date.now();
        break;

      case "tool_execution_end":
        state.currentToolName = null;
        state.currentToolStartedAt = null;
        if (event.isError) {
          state.errorCount++;
        }
        state.lastProgressAt = Date.now();
        break;

      case "turn_end":
        state.turnCount++;
        state.lastProgressAt = Date.now();
        break;

      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        state.lastProgressAt = Date.now();
        break;

      default:
        break;
    }
  }

  private recordWorkerStallProgress(agentId: string): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    stallState.lastProgressAt = Date.now();
    stallState.lastDetailedReportAt = null;
    stallState.lastToolName = null;
    stallState.lastToolInput = null;
    stallState.lastToolOutput = null;

    if (stallState.nudgeSent) {
      stallState.nudgeSent = false;
      stallState.nudgeSentAt = null;
    }

    this.workerStallState.set(agentId, stallState);
  }

  private maybeRecordVersionedToolMutation(agentId: string, event: RuntimeSessionEvent): void {
    if (!this.versioningService) {
      return;
    }

    if (event.type === "tool_execution_start") {
      if (!isVersionedWriteToolName(event.toolName)) {
        return;
      }

      const path = extractVersionedToolPath(event.args);
      if (!path) {
        return;
      }

      const byToolCallId = this.trackedToolPathsByAgentId.get(agentId) ?? new Map<string, { toolName: string; path: string }>();
      byToolCallId.set(event.toolCallId, { toolName: event.toolName, path });
      this.trackedToolPathsByAgentId.set(agentId, byToolCallId);
      return;
    }

    if (event.type !== "tool_execution_end" || event.isError || !isVersionedWriteToolName(event.toolName)) {
      return;
    }

    const descriptor = this.descriptors.get(agentId);
    const tracked = this.trackedToolPathsByAgentId.get(agentId)?.get(event.toolCallId);
    this.trackedToolPathsByAgentId.get(agentId)?.delete(event.toolCallId);

    const path = tracked?.path ?? extractVersionedToolPath(event.result);
    if (!descriptor || !path) {
      return;
    }

    void this.queueVersionedToolMutation(descriptor, {
      path,
      action: "write",
      source: tracked?.toolName === "edit" ? "agent-edit-tool" : "agent-write-tool",
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      agentId
    });
  }

  private async queueVersionedToolMutation(
    descriptor: AgentDescriptor,
    mutation: VersioningMutation
  ): Promise<void> {
    this.queueVersioningMutation({
      ...mutation,
      reviewRunId: await this.resolveActiveCortexReviewRunIdForDescriptor(descriptor)
    });
  }

  private async resolveActiveCortexReviewRunIdForDescriptor(descriptor: AgentDescriptor): Promise<string | undefined> {
    const sessionAgentId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    if (!sessionAgentId) {
      return undefined;
    }

    try {
      const storedRuns = await readStoredCortexReviewRuns(this.config.paths.dataDir);
      return storedRuns.find((run) => run.sessionAgentId === sessionAgentId)?.runId;
    } catch (error) {
      this.logDebug("cortex:review_run:resolve_failed", {
        sessionAgentId,
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
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

  private async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    if (descriptor.role !== "worker" || !descriptor.specialistId || !descriptor.profileId) {
      return undefined;
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (!specialistId) {
      return undefined;
    }

    const roster = await this.resolveSpecialistRosterForProfile(descriptor.profileId);
    const specialist = roster.find((entry) => entry.specialistId === specialistId);
    if (!specialist?.fallbackModelId) {
      return undefined;
    }

    const inferredFallbackProvider = inferProviderFromModelId(specialist.fallbackModelId);
    if (!inferredFallbackProvider) {
      return undefined;
    }

    let fallbackModel: AgentModelDescriptor = {
      provider: inferredFallbackProvider,
      modelId: specialist.fallbackModelId,
      thinkingLevel: specialist.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
    };
    fallbackModel.thinkingLevel = normalizeThinkingLevelForProvider(
      fallbackModel.provider,
      fallbackModel.thinkingLevel
    );
    return this.resolveSpawnModelWithCapacityFallback(fallbackModel);
  }

  private async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    if (!shouldRetrySpecialistSpawnWithFallback(new Error(errorMessage), descriptor.model)) {
      return false;
    }

    const currentRuntime = this.runtimes.get(agentId);
    const suppressedRuntimeToken = runtimeToken ?? this.runtimeTokensByAgentId.get(agentId);
    if (!currentRuntime) {
      return false;
    }

    const previousModel = { ...descriptor.model };
    const previousStatus = descriptor.status;
    const previousUpdatedAt = descriptor.updatedAt;
    const previousStreamingStartedAt = descriptor.streamingStartedAt;
    const previousContextUsage = descriptor.contextUsage ? { ...descriptor.contextUsage } : undefined;
    const previousRuntimeSystemPrompt = currentRuntime.getSystemPrompt?.();

    let fallbackModel: AgentModelDescriptor | undefined;
    let replaySnapshot: SpecialistFallbackReplaySnapshot | undefined;
    let replacementRuntime: SwarmAgentRuntime | undefined;
    let replacementRuntimeToken: number | undefined;
    let runtimeSystemPrompt = "";
    let recovered = false;
    let handoffStarted = false;
    let deferredSettled = false;
    const fallbackRuntimeDeferred = createDeferred<SwarmAgentRuntime>();
    fallbackRuntimeDeferred.promise.catch(() => {
      // getOrCreateRuntimeForDescriptor callers observe this promise directly when waiting on handoff.
      // This no-op catch prevents unhandled rejection noise when no caller was waiting.
    });
    const resolveWaiters = (runtime: SwarmAgentRuntime): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.resolve(runtime);
    };
    const rejectWaiters = (reason: unknown): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.reject(reason);
    };

    this.runtimeCreationPromisesByAgentId.set(agentId, fallbackRuntimeDeferred.promise);

    if (suppressedRuntimeToken !== undefined) {
      this.beginSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      handoffStarted = true;
    }

    try {
      fallbackModel = await this.resolveSpecialistFallbackModelForDescriptor(descriptor);
      if (!fallbackModel) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      if (
        fallbackModel.provider === descriptor.model.provider &&
        fallbackModel.modelId === descriptor.model.modelId &&
        fallbackModel.thinkingLevel === descriptor.model.thinkingLevel
      ) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      replaySnapshot = await currentRuntime.prepareForSpecialistFallbackReplay?.();
      if (!replaySnapshot) {
        await this.reconcileBufferedSpecialistFallbackCallbacksOnAbort(agentId, suppressedRuntimeToken);
        resolveWaiters(currentRuntime);
        return false;
      }

      const fallbackDescriptor: AgentDescriptor = {
        ...descriptor,
        model: { ...fallbackModel },
        status: "idle",
        updatedAt: this.now(),
        contextUsage: undefined
      };
      delete fallbackDescriptor.streamingStartedAt;

      const baseSystemPrompt = await this.resolveSystemPromptForDescriptor(fallbackDescriptor);
      runtimeSystemPrompt = this.injectWorkerIdentityContext(fallbackDescriptor, baseSystemPrompt);
      replacementRuntime = await this.createRuntimeForDescriptor(fallbackDescriptor, runtimeSystemPrompt);
      replacementRuntimeToken = this.runtimeTokensByAgentId.get(agentId);

      if (!this.isSpecialistFallbackHandoffStillValid(agentId, currentRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback handoff was cancelled for ${agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      descriptor.model = { ...fallbackDescriptor.model };
      descriptor.status = fallbackDescriptor.status;
      descriptor.updatedAt = fallbackDescriptor.updatedAt;
      descriptor.contextUsage = undefined;
      delete descriptor.streamingStartedAt;
      this.descriptors.set(agentId, descriptor);
      await this.saveStore();

      this.runtimes.set(agentId, replacementRuntime);

      const persistedSystemPrompt = replacementRuntime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      await this.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
      await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      this.emitStatus(agentId, descriptor.status, replacementRuntime.getPendingCount(), replacementRuntime.getContextUsage());
      this.emitAgentsSnapshot();

      if (!this.isSpecialistFallbackHandoffStillValid(agentId, replacementRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback replay was cancelled for ${agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      this.logDebug("worker:specialist_fallback:rerouted", {
        agentId,
        specialistId: descriptor.specialistId,
        sourcePhase,
        previousModel,
        fallbackModel: descriptor.model,
        message: errorMessage,
        replayPreview: previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160),
        replayMessageCount: replaySnapshot.messages.length
      });

      await this.replaySpecialistFallbackSnapshot(replacementRuntime, replaySnapshot);
      resolveWaiters(replacementRuntime);
      if (suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      }

      void currentRuntime.terminate({ abort: true }).catch((shutdownError) => {
        this.logDebug("worker:specialist_fallback:previous_runtime_shutdown_error", {
          agentId,
          specialistId: descriptor.specialistId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      });

      recovered = true;
      return true;
    } catch (fallbackError) {
      const failureDisposition = this.getSpecialistFallbackFailureDisposition(
        agentId,
        currentRuntime,
        replacementRuntime,
        suppressedRuntimeToken
      );
      await this.discardSpecialistFallbackReplacementRuntime(agentId, replacementRuntime, replacementRuntimeToken);
      let rollbackError: unknown;
      try {
        if (failureDisposition === "restore_original_runtime") {
          await currentRuntime.restorePreparedSpecialistFallbackReplay?.();
          await this.restoreWorkerAfterFailedSpecialistFallback(
            descriptor,
            currentRuntime,
            suppressedRuntimeToken,
            {
              previousModel,
              previousStatus,
              previousUpdatedAt,
              previousStreamingStartedAt,
              previousContextUsage,
              previousRuntimeSystemPrompt
            }
          );
          resolveWaiters(currentRuntime);
        } else {
          await this.terminateSuppressedSpecialistFallbackRuntime(agentId, currentRuntime);
          rejectWaiters(
            new Error(
              failureDisposition === "interrupted"
                ? `Specialist fallback replay was interrupted for ${agentId}`
                : `Specialist fallback replay failed and original runtime is unavailable for ${agentId}`
            )
          );
          if (suppressedRuntimeToken !== undefined) {
            this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
          }
          recovered = failureDisposition === "interrupted";
        }
      } catch (restoreError) {
        rollbackError = restoreError;
        rejectWaiters(restoreError);
      }

      this.logDebug("worker:specialist_fallback:failed", {
        agentId,
        specialistId: descriptor.specialistId,
        sourcePhase,
        previousModel,
        fallbackModel,
        message: errorMessage,
        replayPreview: replaySnapshot
          ? previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160)
          : undefined,
        replayMessageCount: replaySnapshot?.messages.length ?? 0,
        failureDisposition,
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError ?? "")
      });
      return failureDisposition === "interrupted";
    } finally {
      if (handoffStarted && !recovered && suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
      }

      if (!deferredSettled) {
        rejectWaiters(new Error(`Specialist fallback handoff did not settle for ${agentId}`));
      }

      if (this.runtimeCreationPromisesByAgentId.get(agentId) === fallbackRuntimeDeferred.promise) {
        this.runtimeCreationPromisesByAgentId.delete(agentId);
      }
    }
  }

  private async replaySpecialistFallbackSnapshot(
    runtime: SwarmAgentRuntime,
    replaySnapshot: SpecialistFallbackReplaySnapshot
  ): Promise<void> {
    for (const [index, replayMessage] of replaySnapshot.messages.entries()) {
      await runtime.sendMessage(replayMessage, index === 0 ? "auto" : "steer");
    }
  }

  private isSpecialistFallbackHandoffStillValid(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime
  ): boolean {
    const latestDescriptor = this.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return false;
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return false;
    }

    return this.runtimes.get(agentId) === expectedRuntime;
  }

  private async discardSpecialistFallbackReplacementRuntime(
    agentId: string,
    replacementRuntime: SwarmAgentRuntime | undefined,
    replacementRuntimeToken: number | undefined
  ): Promise<void> {
    if (replacementRuntime) {
      try {
        await replacementRuntime.terminate({
          abort: true,
          shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
          drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
      } catch (shutdownError) {
        this.logDebug("worker:specialist_fallback:replacement_runtime_shutdown_error", {
          agentId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      }
    }

    if (replacementRuntimeToken !== undefined) {
      this.detachRuntime(agentId, replacementRuntimeToken);
    } else if (replacementRuntime && this.runtimes.get(agentId) === replacementRuntime) {
      this.runtimes.delete(agentId);
    }
  }

  private async terminateSuppressedSpecialistFallbackRuntime(
    agentId: string,
    runtime: SwarmAgentRuntime
  ): Promise<void> {
    try {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
        drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
    } catch (shutdownError) {
      this.logDebug("worker:specialist_fallback:suppressed_runtime_shutdown_error", {
        agentId,
        message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      });
    }
  }

  private getSpecialistFallbackFailureDisposition(
    agentId: string,
    currentRuntime: SwarmAgentRuntime,
    replacementRuntime: SwarmAgentRuntime | undefined,
    suppressedRuntimeToken: number | undefined
  ): "restore_original_runtime" | "interrupted" | "original_runtime_unavailable" {
    const latestDescriptor = this.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return "interrupted";
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return "interrupted";
    }

    if (replacementRuntime && this.runtimes.get(agentId) !== replacementRuntime) {
      return "interrupted";
    }

    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken)
        : undefined;
    const originalRuntimeStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    if (isNonRunningAgentStatus(originalRuntimeStatus)) {
      return "original_runtime_unavailable";
    }

    return "restore_original_runtime";
  }

  private async restoreWorkerAfterFailedSpecialistFallback(
    descriptor: AgentDescriptor,
    currentRuntime: SwarmAgentRuntime,
    suppressedRuntimeToken: number | undefined,
    previousState: {
      previousModel: AgentModelDescriptor;
      previousStatus: AgentStatus;
      previousUpdatedAt: string;
      previousStreamingStartedAt?: number;
      previousContextUsage?: AgentContextUsage;
      previousRuntimeSystemPrompt?: string | null;
    }
  ): Promise<void> {
    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(descriptor.agentId, suppressedRuntimeToken)
        : undefined;
    const reconciledStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    const reconciledContextUsage =
      handoffState?.bufferedStatus?.contextUsage ?? currentRuntime.getContextUsage() ?? previousState.previousContextUsage;

    descriptor.model = previousState.previousModel;
    descriptor.status = reconciledStatus;
    descriptor.updatedAt = previousState.previousUpdatedAt;
    descriptor.contextUsage = isNonRunningAgentStatus(reconciledStatus) ? undefined : reconciledContextUsage;
    if (reconciledStatus === "streaming" && previousState.previousStreamingStartedAt !== undefined) {
      descriptor.streamingStartedAt = previousState.previousStreamingStartedAt;
    } else {
      delete descriptor.streamingStartedAt;
    }
    this.descriptors.set(descriptor.agentId, descriptor);
    this.runtimes.set(descriptor.agentId, currentRuntime);
    if (suppressedRuntimeToken !== undefined) {
      this.runtimeTokensByAgentId.set(descriptor.agentId, suppressedRuntimeToken);
    }

    this.reconcileWorkerRuntimeStateAfterFallbackRollback(descriptor.agentId, reconciledStatus, handoffState);

    try {
      await this.saveStore();
    } catch (saveError) {
      this.logDebug("worker:specialist_fallback:rollback_save_failed", {
        agentId: descriptor.agentId,
        specialistId: descriptor.specialistId,
        message: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }

    await this.updateSessionMetaForWorkerDescriptor(
      descriptor,
      previousState.previousRuntimeSystemPrompt ?? undefined
    );
    await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

    this.emitStatus(
      descriptor.agentId,
      descriptor.status,
      handoffState?.bufferedStatus?.pendingCount ?? currentRuntime.getPendingCount(),
      descriptor.contextUsage
    );
    this.emitAgentsSnapshot();
  }

  private reconcileWorkerRuntimeStateAfterFallbackRollback(
    agentId: string,
    restoredStatus: AgentStatus,
    handoffState?: SpecialistFallbackHandoffState
  ): void {
    if (restoredStatus === "streaming") {
      if (!this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      }
    } else {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
    }

    if (!handoffState?.receivedAgentEnd) {
      return;
    }

    this.trackedToolPathsByAgentId.delete(agentId);

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    watchdogState.turnSeq += 1;
    watchdogState.reportedThisTurn = false;
    watchdogState.pendingReportTurnSeq = null;
    watchdogState.deferredFinalizeTurnSeq = null;
    watchdogState.hadStreamingThisTurn = false;
    watchdogState.lastFinalizedTurnSeq = watchdogState.turnSeq;
    this.workerWatchdogState.set(agentId, watchdogState);

    this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
    this.clearWatchdogTimer(agentId);
  }

  private async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrError as string)
      : runtimeTokenOrAgentId;
    const error = invokedWithExplicitToken ? maybeError : (agentIdOrError as RuntimeErrorEvent);

    if (!error) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    this.maybeRecordModelCapacityBlock(agentId, descriptor, {
      ...error,
      message
    });

    const forgeBindingRuntimeToken = runtimeToken ?? this.runtimeTokensByAgentId.get(agentId);
    if (forgeBindingRuntimeToken !== undefined) {
      await this.forgeExtensionHost.dispatchRuntimeError(createForgeBindingToken(forgeBindingRuntimeToken), {
        ...error,
        message
      });
    }

    if (error.phase === "prompt_dispatch" || error.phase === "prompt_start") {
      const recoveredWithFallback = await this.maybeRecoverWorkerWithSpecialistFallback(
        agentId,
        message,
        error.phase,
        runtimeToken
      );
      if (recoveredWithFallback) {
        return;
      }
    }

    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");
    const recoveryStage = readStringDetail(error.details, "recoveryStage");

    this.logDebug("runtime:error", {
      agentId,
      runtime: descriptor.model.provider.includes("codex-app") ? "codex-app-server" : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const extensionPath = readStringDetail(error.details, "extensionPath");
    const extensionEvent = readStringDetail(error.details, "event");
    const extensionBaseName = extensionPath ? basename(extensionPath) : undefined;
    const userFacingMessage = readStringDetail(error.details, "userFacingMessage");

    // Track successful auto-compaction
    if (error.phase === "compaction" && recoveryStage === "auto_compaction_succeeded" && descriptor.profileId) {
      const autoCount = await incrementSessionCompactionCount(
        this.config.paths.dataDir,
        descriptor.profileId,
        agentId
      ).catch((err) => {
        this.logDebug("runtime:compact:count-increment-failed", { agentId, error: String(err) });
        return undefined;
      });
      if (autoCount !== undefined) {
        descriptor.compactionCount = autoCount;
      }
    }

    const text =
      userFacingMessage
      ?? (
        error.phase === "compaction"
          ? recoveryStage === "auto_compaction_succeeded"
            ? `📋 ${message}.`
            : recoveryStage === "recovery_failed"
              ? `🚨 Context recovery failed: ${message}. Start a new session or manually trim history/compact before continuing.`
              : `⚠️ Compaction error${retryLabel}: ${message}. Attempting fallback recovery.`
          : error.phase === "context_guard"
            ? recoveryStage === "guard_started"
              ? `📋 ${message}.`
              : `⚠️ Context guard error${retryLabel}: ${message}.`
            : error.phase === "extension"
              ? extensionBaseName && extensionEvent
                ? `⚠️ Extension error (${extensionBaseName} · ${extensionEvent}): ${message}`
                : extensionBaseName
                  ? `⚠️ Extension error (${extensionBaseName}): ${message}`
                  : `⚠️ Extension error: ${message}`
              : droppedPendingCount && droppedPendingCount > 0
                ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
                : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`
      );

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.now(),
      source: "system"
    });
  }

  private captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    this.conversationProjector.captureConversationEventFromRuntime(agentId, event);
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

    const reviewSessionDescriptor = descriptor?.sessionPurpose === "cortex_review"
      ? descriptor
      : descriptor?.role === "worker"
        ? this.descriptors.get(descriptor.managerId)
        : undefined;
    if (reviewSessionDescriptor?.sessionPurpose === "cortex_review") {
      this.scheduleCortexReviewRunQueueCheck(status === "streaming" ? CORTEX_REVIEW_RUN_QUEUE_RETRY_MS : 0);
    }
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
    try {
      await rebuildSessionMeta({
        dataDir: this.config.paths.dataDir,
        agentsStoreFile: this.config.paths.agentsStoreFile,
        descriptors: this.sortedDescriptors(),
        now: this.now
      });
    } catch (error) {
      this.logDebug("session:meta:rebuild_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async hydrateCompactionCountsForBoot(): Promise<void> {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") continue;
      const profileId = descriptor.profileId ?? descriptor.agentId;
      try {
        const meta = await readSessionMeta(this.config.paths.dataDir, profileId, descriptor.agentId);
        if (meta?.compactionCount) {
          descriptor.compactionCount = meta.compactionCount;
        }
      } catch {
        // Ignore — compactionCount remains undefined
      }
    }
  }

  private async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const existingMeta = await readSessionMeta(this.config.paths.dataDir, profileId, descriptor.agentId);
    const base = existingMeta ?? this.createSessionMetaSkeleton(descriptor);

    const next: SessionMeta = {
      ...base,
      sessionId: descriptor.agentId,
      profileId,
      label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? base.label,
      model: {
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId
      },
      createdAt: descriptor.createdAt,
      updatedAt: this.now(),
      cwd: descriptor.cwd,
      stats: this.buildSessionMetaStats(base.workers, {
        sessionFileSize: base.stats.sessionFileSize,
        memoryFileSize: base.stats.memoryFileSize
      })
    };

    await writeSessionMeta(this.config.paths.dataDir, next);
  }

  private async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;

    try {
      await this.skillMetadataService.ensureSkillMetadataLoaded();

      const memoryFilePath = this.getAgentMemoryPath(descriptor.agentId);
      const profileMemoryPath = getProfileMemoryPath(this.config.paths.dataDir, profileId);

      const agentsFileCandidate = join(descriptor.cwd, "AGENTS.md");
      const promptComponents: NonNullable<SessionMeta["promptComponents"]> = {
        archetype: descriptor.archetypeId ?? MANAGER_ARCHETYPE_ID,
        agentsFile: existsSync(agentsFileCandidate) ? agentsFileCandidate : null,
        skills: this.skillMetadataService.getAdditionalSkillPaths(),
        memoryFile: memoryFilePath,
        profileMemoryFile: profileMemoryPath
      };

      const resolvedSystemPromptForMeta =
        resolvedSystemPrompt === undefined ? await this.resolveSystemPromptForDescriptor(descriptor) : resolvedSystemPrompt;
      const existingMeta = await readSessionMeta(this.config.paths.dataDir, profileId, descriptor.agentId);
      const base = existingMeta ?? this.createSessionMetaSkeleton(descriptor);

      const next: SessionMeta = {
        ...base,
        sessionId: descriptor.agentId,
        profileId,
        label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? base.label,
        model: {
          provider: descriptor.model.provider,
          modelId: descriptor.model.modelId
        },
        cwd: descriptor.cwd,
        resolvedSystemPrompt: resolvedSystemPromptForMeta,
        promptComponents,
        promptFingerprint: computePromptFingerprint(promptComponents),
        updatedAt: this.now()
      };

      await writeSessionMeta(this.config.paths.dataDir, next);
    } catch (error) {
      this.logDebug("session:meta:prompt_capture_error", {
        sessionAgentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private createSessionMetaSkeleton(descriptor: AgentDescriptor): SessionMeta {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const timestamp = this.now();

    return {
      sessionId: descriptor.agentId,
      profileId,
      label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? null,
      model: {
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId
      },
      createdAt: descriptor.createdAt,
      updatedAt: timestamp,
      cwd: descriptor.cwd,
      resolvedSystemPrompt: null,
      promptFingerprint: null,
      promptComponents: null,
      feedbackFileSize: null,
      lastFeedbackAt: null,
      cortexReviewedFeedbackBytes: 0,
      cortexReviewedFeedbackAt: null,
      memoryMergeAttemptCount: 0,
      lastMemoryMergeAttemptId: null,
      lastMemoryMergeAttemptAt: null,
      lastMemoryMergeAppliedAt: null,
      lastMemoryMergeStatus: null,
      lastMemoryMergeStrategy: null,
      lastMemoryMergeFailureStage: null,
      lastMemoryMergeSourceHash: null,
      lastMemoryMergeProfileHashBefore: null,
      lastMemoryMergeProfileHashAfter: null,
      lastMemoryMergeAppliedSourceHash: null,
      lastMemoryMergeError: null,
      workers: [],
      stats: {
        totalWorkers: 0,
        activeWorkers: 0,
        totalTokens: {
          input: null,
          output: null
        },
        sessionFileSize: null,
        memoryFileSize: null
      }
    };
  }

  private buildSessionMetaStats(
    workers: SessionMeta["workers"],
    fileSizes: { sessionFileSize: string | null; memoryFileSize: string | null }
  ): SessionMeta["stats"] {
    const inputTokens = workers
      .map((worker) => worker.tokens.input)
      .filter((value): value is number => typeof value === "number");
    const outputTokens = workers
      .map((worker) => worker.tokens.output)
      .filter((value): value is number => typeof value === "number");

    return {
      totalWorkers: workers.length,
      activeWorkers: workers.filter((worker) => worker.status === "streaming").length,
      totalTokens: {
        input: inputTokens.length > 0 ? inputTokens.reduce((sum, value) => sum + value, 0) : null,
        output: outputTokens.length > 0 ? outputTokens.reduce((sum, value) => sum + value, 0) : null
      },
      sessionFileSize: fileSizes.sessionFileSize,
      memoryFileSize: fileSizes.memoryFileSize
    };
  }

  private async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void> {
    if (descriptor.role !== "worker") {
      return;
    }

    const managerDescriptor = this.descriptors.get(descriptor.managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager") {
      return;
    }

    const profileId = managerDescriptor.profileId ?? managerDescriptor.agentId;

    try {
      await updateSessionMetaWorker(
        this.config.paths.dataDir,
        profileId,
        managerDescriptor.agentId,
        {
          id: descriptor.agentId,
          model: this.buildWorkerModelIdentifier(descriptor),
          specialistId: normalizeOptionalAgentId(descriptor.specialistId) ?? null,
          status: this.mapWorkerStatusForMeta(descriptor.status),
          createdAt: descriptor.createdAt,
          terminatedAt: descriptor.status === "terminated" ? descriptor.updatedAt : null,
          tokens: {
            input:
              typeof descriptor.contextUsage?.tokens === "number"
                ? Math.max(0, Math.round(descriptor.contextUsage.tokens))
                : null,
            output: null
          },
          systemPrompt: resolvedSystemPrompt
        },
        this.now
      );
    } catch (error) {
      this.logDebug("session:meta:worker_update_error", {
        workerId: descriptor.agentId,
        managerId: descriptor.managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private mapWorkerStatusForMeta(status: AgentStatus): SessionMeta["workers"][number]["status"] {
    if (status === "terminated") {
      return "terminated";
    }

    if (status === "streaming") {
      return "streaming";
    }

    return "idle";
  }

  private buildWorkerModelIdentifier(descriptor: AgentDescriptor): string | null {
    const provider = normalizeOptionalAgentId(descriptor.model.provider);
    const modelId = normalizeOptionalAgentId(descriptor.model.modelId);

    if (!provider || !modelId) {
      return null;
    }

    return `${provider}/${modelId}`;
  }

  private async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    if (descriptor.role !== "manager") {
      return;
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const memoryFilePath = this.getAgentMemoryPath(descriptor.agentId);

    try {
      const updated = await updateSessionMetaStats(this.config.paths.dataDir, profileId, descriptor.agentId, {
        sessionFilePath: sessionFileOverride ?? descriptor.sessionFile,
        memoryFilePath,
        now: this.now
      });

      if (!updated) {
        await this.writeInitialSessionMeta(descriptor);
        await updateSessionMetaStats(this.config.paths.dataDir, profileId, descriptor.agentId, {
          sessionFilePath: sessionFileOverride ?? descriptor.sessionFile,
          memoryFilePath,
          now: this.now
        });
      }
    } catch (error) {
      this.logDebug("session:meta:stats_update_error", {
        sessionAgentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    const descriptor = this.descriptors.get(sessionAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    await this.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  private isRuntimeInContextRecovery(agentId: string): boolean {
    const runtime = this.runtimes.get(agentId);
    return Boolean(runtime?.isContextRecoveryInProgress?.());
  }

  private async checkForStalledWorkers(): Promise<void> {
    if (this.stallCheckPromise) {
      return this.stallCheckPromise;
    }

    const run = this.runStalledWorkerCheck().finally(() => {
      if (this.stallCheckPromise === run) {
        this.stallCheckPromise = null;
      }
    });

    this.stallCheckPromise = run;
    return run;
  }

  private async runStalledWorkerCheck(): Promise<void> {
    const now = Date.now();

    for (const [agentId, descriptor] of this.descriptors.entries()) {
      if (descriptor.role !== "worker" || descriptor.status !== "streaming") {
        continue;
      }

      const stallState = this.workerStallState.get(agentId);
      if (!stallState) {
        continue;
      }

      if (this.isRuntimeInContextRecovery(agentId)) {
        continue;
      }

      const elapsedSinceProgressMs = now - stallState.lastProgressAt;
      if (stallState.nudgeSent && stallState.nudgeSentAt !== null) {
        const elapsedSinceNudgeMs = now - stallState.nudgeSentAt;
        if (elapsedSinceNudgeMs >= STALL_KILL_AFTER_NUDGE_MS) {
          await this.handleStallAutoKill(agentId, elapsedSinceProgressMs);
          continue;
        }

        const detailedReportDue =
          elapsedSinceProgressMs >= STALL_DETAILED_REPORT_INTERVAL_MS &&
          (
            stallState.lastDetailedReportAt === null ||
            now - stallState.lastDetailedReportAt >= STALL_DETAILED_REPORT_INTERVAL_MS
          );

        if (detailedReportDue) {
          await this.handleStallDetailedReport(agentId, elapsedSinceProgressMs);
          continue;
        }
      }

      if (!stallState.nudgeSent && elapsedSinceProgressMs >= STALL_NUDGE_THRESHOLD_MS) {
        await this.handleStallNudge(agentId, elapsedSinceProgressMs);
      }
    }
  }

  private async handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isRuntimeInContextRecovery(agentId)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const managerMessage = `SYSTEM: ⚠️ [WORKER STALL DETECTED]\nWorker \`${agentId}\` has made no progress for ${elapsedText}.\nIt may be stuck in a long-running tool call or hung process.\nConsider: send_message_to_agent to check on it, or kill_agent(\"${agentId}\") to terminate.`;

    try {
      await this.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.nudgeSent = true;
      stallState.nudgeSentAt = Date.now();
      stallState.lastDetailedReportAt = null;
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.logDebug("stall:nudge:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.logDebug("stall:nudge:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isRuntimeInContextRecovery(agentId)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || !stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const toolInfo = stallState.lastToolName
      ? `Tool: ${toDisplayToolName(stallState.lastToolName)}`
      : "Tool: unknown (no tool execution events received)";
    const inputPreview = stallState.lastToolInput
      ? `Input (truncated): ${trimToMaxChars(stallState.lastToolInput, 200)}`
      : "Input: not available";
    const outputPreview = stallState.lastToolOutput
      ? `Last output (truncated): ${trimToMaxCharsFromEnd(stallState.lastToolOutput, 200)}`
      : "Output: none received";

    const managerMessage =
      `SYSTEM: ⚠️ [WORKER STALL REPORT]\n` +
      `Worker \`${agentId}\` has made no progress for ${elapsedText}.\n\n` +
      `${toolInfo}\n${inputPreview}\n${outputPreview}\n\n` +
      `If this looks like a hung process, terminate with: kill_agent("${agentId}")\n` +
      "If it's a legitimate long-running operation, no action needed — auto-termination will occur at 30 minutes total.";

    try {
      await this.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.lastDetailedReportAt = Date.now();
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.logDebug("stall:detailed_report:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` still appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.logDebug("stall:detailed_report:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isRuntimeInContextRecovery(agentId)) {
      if (descriptor.status !== "streaming") {
        this.workerStallState.delete(agentId);
        this.workerActivityState.delete(agentId);
      }
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    const elapsedText = this.formatDuration(elapsedMs);

    try {
      await this.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      await this.saveStore();
      this.emitAgentsSnapshot();
    } catch (error) {
      this.logDebug("stall:auto_kill:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });

      if (managerId) {
        try {
          await this.publishToUser(
            managerId,
            `⚠️ Failed to auto-terminate stalled worker \`${agentId}\` — manual intervention needed.`,
            "system"
          );
        } catch (publishError) {
          this.logDebug("stall:auto_kill:publish_to_user:error", {
            agentId,
            managerId,
            message: publishError instanceof Error ? publishError.message : String(publishError)
          });
        }
      }
      return;
    }

    if (!managerId) {
      return;
    }

    const managerDescriptor = this.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const managerMessage = `SYSTEM: 🛑 [STALLED WORKER AUTO-TERMINATED]\nWorker \`${agentId}\` was automatically terminated after ${elapsedText} with no progress.\nThe worker was stuck in a tool execution that never completed.\nYou may need to spawn a replacement worker or handle the incomplete task.`;

    try {
      await this.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
    } catch (error) {
      this.logDebug("stall:auto_kill:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.publishToUser(
        managerId,
        `🛑 Worker \`${agentId}\` auto-terminated after ${elapsedText} stall.`,
        "system"
      );
    } catch (error) {
      this.logDebug("stall:auto_kill:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  private async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    const runtimeToken = typeof runtimeTokenOrAgentId === "number" ? runtimeTokenOrAgentId : undefined;
    const agentId = typeof runtimeTokenOrAgentId === "number" ? maybeAgentId : runtimeTokenOrAgentId;

    if (!agentId) {
      return;
    }

    if (
      runtimeToken !== undefined &&
      this.bufferSpecialistFallbackAgentEndDuringHandoff(agentId, runtimeToken)
    ) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }
    this.trackedToolPathsByAgentId.delete(agentId);
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    if (this.isRuntimeInContextRecovery(agentId)) {
      const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
      watchdogState.turnSeq += 1;
      watchdogState.reportedThisTurn = false;
      watchdogState.pendingReportTurnSeq = null;
      watchdogState.deferredFinalizeTurnSeq = null;
      watchdogState.hadStreamingThisTurn = false;
      watchdogState.lastFinalizedTurnSeq = watchdogState.turnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);

      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "agent_end");
  }

  private async finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void> {
    if (descriptor.role !== "worker") {
      return;
    }

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    const currentTurnSeq = watchdogState.turnSeq;
    if (watchdogState.lastFinalizedTurnSeq === currentTurnSeq && !watchdogState.hadStreamingThisTurn) {
      this.logDebug("watchdog:finalize_skip_duplicate", {
        agentId,
        turnSeq: currentTurnSeq,
        source
      });
      return;
    }

    const reportedThisTurn = watchdogState.reportedThisTurn;
    const hasPendingReport = watchdogState.pendingReportTurnSeq === currentTurnSeq;

    if (hasPendingReport) {
      watchdogState.deferredFinalizeTurnSeq = currentTurnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);
      return;
    }

    // Reset watchdog state for the next agentic loop.
    watchdogState.turnSeq += 1;
    watchdogState.reportedThisTurn = false;
    watchdogState.pendingReportTurnSeq = null;
    watchdogState.deferredFinalizeTurnSeq = null;
    watchdogState.hadStreamingThisTurn = false;
    const turnSeq = watchdogState.turnSeq;
    watchdogState.lastFinalizedTurnSeq = turnSeq;
    this.workerWatchdogState.set(agentId, watchdogState);

    if (reportedThisTurn) {
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const autoReportOutcome = await this.tryAutoReportWorkerCompletion(descriptor);
    if (autoReportOutcome === "sent") {
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const nextToken = (this.watchdogTimerTokens.get(agentId) ?? 0) + 1;
    this.watchdogTimerTokens.set(agentId, nextToken);
    this.clearWatchdogTimer(agentId);

    const timer = setTimeout(() => {
      this.handleIdleWorkerWatchdogTimer(agentId, turnSeq, nextToken).catch((error) => {
        this.logDebug("watchdog:error", { agentId, error: String(error) });
      });
    }, IDLE_WORKER_WATCHDOG_GRACE_MS);

    this.watchdogTimers.set(agentId, timer);
  }

  private async finalizeDeferredWorkerIdleTurn(agentId: string, turnSeq: number): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (
      !watchdogState ||
      watchdogState.turnSeq !== turnSeq ||
      watchdogState.pendingReportTurnSeq !== null ||
      watchdogState.deferredFinalizeTurnSeq !== turnSeq
    ) {
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "deferred");
  }

  private seedWorkerCompletionReportTimestamp(agentId: string): void {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    this.lastWorkerCompletionReportTimestampByAgentId.set(agentId, parseTimestampToMillis(this.now()) ?? Date.now());
    this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(agentId);
  }

  private async tryAutoReportWorkerCompletion(
    descriptor: AgentDescriptor
  ): Promise<"sent" | "skipped" | "failed"> {
    if (descriptor.role !== "worker") {
      return "skipped";
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return "skipped";
    }

    const managerDescriptor = this.descriptors.get(managerId);
    const managerRuntime = this.runtimes.get(managerId);
    if (
      !managerDescriptor ||
      managerDescriptor.role !== "manager" ||
      isNonRunningAgentStatus(managerDescriptor.status) ||
      !managerRuntime
    ) {
      this.logDebug("worker:completion_report:skip_manager_unavailable", {
        workerAgentId: descriptor.agentId,
        managerId,
        managerStatus: managerDescriptor?.status,
        hasManagerRuntime: Boolean(managerRuntime)
      });
      return "skipped";
    }

    const workerRuntime = this.runtimes.get(descriptor.agentId);
    if (!workerRuntime) {
      this.logDebug("worker:completion_report:skip_worker_runtime_missing", {
        workerAgentId: descriptor.agentId,
        managerId
      });
      return "skipped";
    }

    if (workerRuntime.getStatus() !== "idle" || workerRuntime.getPendingCount() > 0) {
      this.logDebug("worker:completion_report:skip_worker_runtime_active", {
        workerAgentId: descriptor.agentId,
        managerId,
        workerStatus: workerRuntime.getStatus(),
        pendingCount: workerRuntime.getPendingCount()
      });
      return "skipped";
    }

    const report = buildWorkerCompletionReport(descriptor.agentId, this.getConversationHistory(descriptor.agentId));
    const lastReportedTimestamp = this.lastWorkerCompletionReportTimestampByAgentId.get(descriptor.agentId);
    const lastReportedSummaryKey = this.lastWorkerCompletionReportSummaryKeyByAgentId.get(descriptor.agentId);
    const hasFreshSummary =
      typeof report.summaryTimestamp === "number" &&
      (typeof lastReportedTimestamp !== "number" || report.summaryTimestamp > lastReportedTimestamp);
    const isDuplicateSummary = typeof report.summaryKey === "string" && report.summaryKey === lastReportedSummaryKey;

    if (isDuplicateSummary) {
      this.logDebug("worker:completion_report:suppress_duplicate_summary", {
        workerAgentId: descriptor.agentId,
        managerId,
        summaryTimestamp: report.summaryTimestamp,
        summaryKey: report.summaryKey
      });
    }

    const includeSummary = hasFreshSummary && !isDuplicateSummary;
    const message = includeSummary
      ? report.message
      : `SYSTEM: Worker ${descriptor.agentId} completed its turn.`;

    try {
      await this.sendMessage(managerId, managerId, message, "auto", {
        origin: "internal"
      });

      if ((includeSummary || isDuplicateSummary) && typeof report.summaryTimestamp === "number") {
        this.lastWorkerCompletionReportTimestampByAgentId.set(descriptor.agentId, report.summaryTimestamp);
        if (report.summaryKey) {
          this.lastWorkerCompletionReportSummaryKeyByAgentId.set(descriptor.agentId, report.summaryKey);
        }
      }

      this.logDebug("worker:completion_report:sent", {
        workerAgentId: descriptor.agentId,
        managerId,
        includedSummary: includeSummary,
        summaryTimestamp: includeSummary ? report.summaryTimestamp : undefined,
        textPreview: previewForLog(message)
      });

      return "sent";
    } catch (error) {
      this.logDebug("worker:completion_report:error", {
        workerAgentId: descriptor.agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
      return "failed";
    }
  }

  private async handleIdleWorkerWatchdogTimer(
    agentId: string,
    turnSeq: number,
    token: number
  ): Promise<void> {
    if (this.watchdogTimerTokens.get(agentId) !== token) {
      return;
    }

    this.watchdogTimers.delete(agentId);

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.clearWatchdogState(agentId);
      return;
    }

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (!watchdogState || watchdogState.turnSeq !== turnSeq || watchdogState.reportedThisTurn) {
      return;
    }

    if (watchdogState.circuitOpen) {
      return;
    }

    if (Date.now() < watchdogState.suppressedUntilMs) {
      return;
    }

    if (descriptor.status !== "idle") {
      return;
    }

    if (this.isRuntimeInContextRecovery(descriptor.agentId)) {
      return;
    }

    const parentDescriptor = this.descriptors.get(descriptor.managerId);
    if (!parentDescriptor || isNonRunningAgentStatus(parentDescriptor.status)) {
      return;
    }

    if (this.isRuntimeInContextRecovery(parentDescriptor.agentId)) {
      return;
    }

    this.enqueueWatchdogForBatch(descriptor.managerId, descriptor.agentId, turnSeq);
  }

  private enqueueWatchdogForBatch(managerId: string, workerId: string, turnSeq: number): void {
    let queue = this.watchdogBatchQueueByManager.get(managerId);
    if (!queue) {
      queue = new Map<string, WatchdogBatchEntry>();
      this.watchdogBatchQueueByManager.set(managerId, queue);
    }
    queue.set(workerId, { workerId, turnSeq });

    if (this.watchdogBatchTimersByManager.has(managerId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.flushWatchdogBatch(managerId).catch((error) => {
        this.logDebug("watchdog:batch_flush:error", {
          managerId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, WATCHDOG_BATCH_WINDOW_MS);

    this.watchdogBatchTimersByManager.set(managerId, timer);
  }

  private async flushWatchdogBatch(managerId: string): Promise<void> {
    const batchTimer = this.watchdogBatchTimersByManager.get(managerId);
    if (batchTimer) {
      clearTimeout(batchTimer);
      this.watchdogBatchTimersByManager.delete(managerId);
    }

    const queuedWorkers = this.watchdogBatchQueueByManager.get(managerId);
    this.watchdogBatchQueueByManager.delete(managerId);

    if (!queuedWorkers || queuedWorkers.size === 0) {
      return;
    }

    const managerDescriptor = this.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    if (this.isRuntimeInContextRecovery(managerId)) {
      return;
    }

    const nowMs = Date.now();
    const eligibleWorkerIds: string[] = [];

    for (const queuedWorker of queuedWorkers.values()) {
      const workerDescriptor = this.descriptors.get(queuedWorker.workerId);
      if (!workerDescriptor || workerDescriptor.role !== "worker" || workerDescriptor.managerId !== managerId) {
        continue;
      }

      if (workerDescriptor.status !== "idle") {
        continue;
      }

      if (this.isRuntimeInContextRecovery(queuedWorker.workerId)) {
        continue;
      }

      const watchdogState = this.workerWatchdogState.get(queuedWorker.workerId);
      if (
        !watchdogState ||
        watchdogState.turnSeq !== queuedWorker.turnSeq ||
        watchdogState.reportedThisTurn ||
        watchdogState.circuitOpen
      ) {
        continue;
      }

      if (nowMs < watchdogState.suppressedUntilMs) {
        continue;
      }

      eligibleWorkerIds.push(queuedWorker.workerId);
    }

    if (eligibleWorkerIds.length === 0) {
      return;
    }

    const previewWorkerIds = eligibleWorkerIds.slice(0, WATCHDOG_BATCH_PREVIEW_LIMIT);
    const omittedCount = eligibleWorkerIds.length - previewWorkerIds.length;
    const workersPreview =
      previewWorkerIds.map((workerId) => `\`${workerId}\``).join(", ") +
      (omittedCount > 0 ? ` (+${omittedCount} more)` : "");

    const workerWord = eligibleWorkerIds.length === 1 ? "worker" : "workers";
    const profileId = managerDescriptor.profileId ?? managerId;
    const watchdogTemplate = await this.resolvePromptWithFallback(
      "operational",
      "idle-watchdog",
      profileId,
      IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE
    );
    const watchdogMessage = resolvePromptVariables(watchdogTemplate, {
      WORKER_COUNT: String(eligibleWorkerIds.length),
      WORKER_WORD: workerWord,
      WORKER_IDS: workersPreview
    });

    if (this.isRuntimeInContextRecovery(managerId)) {
      return;
    }

    let managerNotified = false;
    try {
      await this.sendMessage(managerId, managerId, watchdogMessage, "auto", { origin: "internal" });
      managerNotified = true;
    } catch (error) {
      this.logDebug("watchdog:notify:error", {
        managerId,
        workerCount: eligibleWorkerIds.length,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const userVisibleMessage = managerNotified
      ? `⚠️ Idle worker watchdog detected ${eligibleWorkerIds.length} ${workerWord} without a report this turn. Workers: ${workersPreview}.`
      : `⚠️ Idle worker watchdog detected ${eligibleWorkerIds.length} ${workerWord} without a report this turn. An automated manager notification was attempted.`;

    try {
      await this.publishToUser(managerId, userVisibleMessage, "system");
    } catch (error) {
      this.logDebug("watchdog:publish_to_user:error", {
        managerId,
        workerCount: eligibleWorkerIds.length,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const suppressionAppliedAtMs = Date.now();

    for (const workerId of eligibleWorkerIds) {
      const watchdogState = this.workerWatchdogState.get(workerId);
      if (!watchdogState) {
        continue;
      }

      watchdogState.consecutiveNotifications += 1;

      if (watchdogState.consecutiveNotifications >= WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS) {
        watchdogState.circuitOpen = true;
        watchdogState.suppressedUntilMs = Number.MAX_SAFE_INTEGER;
        this.logDebug("watchdog:circuit_open", {
          workerAgentId: workerId,
          managerId,
          consecutiveNotifications: watchdogState.consecutiveNotifications
        });
      } else {
        const backoffMs = Math.min(
          WATCHDOG_BACKOFF_BASE_MS * 2 ** (watchdogState.consecutiveNotifications - 1),
          WATCHDOG_BACKOFF_MAX_MS
        );
        watchdogState.suppressedUntilMs = suppressionAppliedAtMs + backoffMs;
      }

      this.workerWatchdogState.set(workerId, watchdogState);
    }
  }

  private getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogState {
    const existing = this.workerWatchdogState.get(agentId);
    if (existing) {
      return existing;
    }

    const initialized: WorkerWatchdogState = {
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: false,
      lastFinalizedTurnSeq: null,
      consecutiveNotifications: 0,
      suppressedUntilMs: 0,
      circuitOpen: false
    };
    this.workerWatchdogState.set(agentId, initialized);
    return initialized;
  }

  private clearWatchdogTimer(agentId: string): void {
    const timer = this.watchdogTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.watchdogTimers.delete(agentId);
    }
  }

  private clearWatchdogState(agentId: string): void {
    this.clearWatchdogTimer(agentId);

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (watchdogState) {
      watchdogState.pendingReportTurnSeq = null;
      watchdogState.deferredFinalizeTurnSeq = null;
      watchdogState.reportedThisTurn = false;
      watchdogState.hadStreamingThisTurn = false;
      watchdogState.lastFinalizedTurnSeq = null;
    }

    this.workerWatchdogState.delete(agentId);
    this.watchdogTimerTokens.delete(agentId);
    this.removeWorkerFromWatchdogBatchQueues(agentId);
  }

  private removeWorkerFromWatchdogBatchQueues(agentId: string): void {
    for (const [managerId, queue] of this.watchdogBatchQueueByManager.entries()) {
      if (!queue.delete(agentId)) {
        continue;
      }

      if (queue.size > 0) {
        continue;
      }

      this.watchdogBatchQueueByManager.delete(managerId);

      const batchTimer = this.watchdogBatchTimersByManager.get(managerId);
      if (batchTimer) {
        clearTimeout(batchTimer);
        this.watchdogBatchTimersByManager.delete(managerId);
      }
    }
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

  private async acquireProfileMergeLock(profileId: string): Promise<() => void> {
    const previousLock = this.profileMergeMutexes.get(profileId) ?? Promise.resolve();
    let released = false;
    let releaseCurrentLock: (() => void) | undefined;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });

    this.profileMergeMutexes.set(profileId, currentLock);
    await previousLock;

    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseCurrentLock?.();

      if (this.profileMergeMutexes.get(profileId) === currentLock) {
        this.profileMergeMutexes.delete(profileId);
      }
    };
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
    const authFilePath = await ensureCanonicalAuthFilePath(this.config);
    const authStorage = AuthStorage.create(authFilePath);
    const piModelsJsonPath = this.getPiModelsJsonPathOrThrow();
    const modelRegistry = createPiModelRegistry(authStorage, piModelsJsonPath);
    const model = resolveModel(modelRegistry, descriptor.model);

    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId} for memory merge.`
      );
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    const memoryMergePrompt = await this.resolvePromptWithFallback(
      "operational",
      "memory-merge",
      descriptor.profileId ?? descriptor.managerId,
      MEMORY_MERGE_SYSTEM_PROMPT
    );
    const mergedContent = await executeLLMMerge(model, profileMemoryContent, sessionMemoryContent, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      systemPrompt: memoryMergePrompt
    });

    return {
      mergedContent,
      model: `${model.provider}/${model.id}`
    };
  }

  private async writeSessionMemoryMergeAttemptMeta(
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
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const existingMeta = await readSessionMeta(this.config.paths.dataDir, profileId, descriptor.agentId);
    const base = existingMeta ?? this.createSessionMetaSkeleton(descriptor);

    const next: SessionMeta = {
      ...base,
      sessionId: descriptor.agentId,
      profileId,
      label: normalizeOptionalAgentId(descriptor.sessionLabel) ?? base.label,
      model: {
        provider: descriptor.model.provider,
        modelId: descriptor.model.modelId
      },
      cwd: descriptor.cwd,
      updatedAt: attempt.timestamp,
      memoryMergeAttemptCount: (base.memoryMergeAttemptCount ?? 0) + 1,
      lastMemoryMergeAttemptId: attempt.attemptId ?? (base.lastMemoryMergeAttemptId ?? null),
      lastMemoryMergeAttemptAt: attempt.timestamp,
      lastMemoryMergeAppliedAt:
        attempt.status === "applied"
          ? attempt.timestamp
          : attempt.appliedSourceHash
            ? attempt.timestamp
            : (base.lastMemoryMergeAppliedAt ?? null),
      lastMemoryMergeStatus: attempt.status,
      lastMemoryMergeStrategy: attempt.strategy ?? null,
      lastMemoryMergeFailureStage: attempt.failureStage ?? null,
      lastMemoryMergeSourceHash: attempt.sessionContentHash ?? null,
      lastMemoryMergeProfileHashBefore:
        attempt.profileContentHashBefore ?? (base.lastMemoryMergeProfileHashBefore ?? null),
      lastMemoryMergeProfileHashAfter:
        attempt.profileContentHashAfter ?? (base.lastMemoryMergeProfileHashAfter ?? null),
      lastMemoryMergeAppliedSourceHash: attempt.appliedSourceHash ?? (base.lastMemoryMergeAppliedSourceHash ?? null),
      lastMemoryMergeError: attempt.error ?? null
    };

    await writeSessionMeta(this.config.paths.dataDir, next);
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

  private async recordSessionMemoryMergeFailureAttemptSafely(
    descriptor: AgentDescriptor,
    attempt: {
      attemptId?: string | null;
      timestamp: string;
      strategy?: SessionMemoryMergeStrategy | null;
      failureStage: SessionMemoryMergeFailureStage;
      sessionContentHash?: string | null;
      profileContentHashBefore?: string | null;
      profileContentHashAfter?: string | null;
      appliedSourceHash?: string | null;
      error?: string;
    }
  ): Promise<string | undefined> {
    try {
      await this.recordSessionMemoryMergeAttempt(descriptor, {
        ...attempt,
        status: "failed"
      });
      return undefined;
    } catch (recordError) {
      try {
        await this.writeSessionMemoryMergeAttemptMeta(descriptor, {
          ...attempt,
          status: "failed"
        });
        return undefined;
      } catch (fallbackError) {
        return `failed to persist merge-attempt metadata (${errorToMessage(recordError)}; fallback: ${errorToMessage(fallbackError)})`;
      }
    }
  }

  private async appendSessionMemoryMergeAuditEntry(entry: SessionMemoryMergeAuditEntry): Promise<void> {
    const auditLogPath = getProfileMergeAuditLogPath(this.config.paths.dataDir, entry.profileId);
    await appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async finalizeSessionMemoryMergeFailure(
    descriptor: AgentDescriptor,
    context: SessionMemoryMergeFailureContext,
    error: unknown
  ): Promise<SessionMemoryMergeFailure> {
    const errorMessage = errorToMessage(error);

    if (context.stage === "llm") {
      this.logDebug("session:memory_merge:llm_failed", {
        sessionAgentId: descriptor.agentId,
        profileId: context.profileId,
        model: descriptor.model,
        message: errorMessage
      });
    }

    const mergeErrorMessage = `Session memory merge failed during ${context.stage}: ${errorMessage}`;
    const metaFailure = await this.recordSessionMemoryMergeFailureAttemptSafely(descriptor, {
      attemptId: context.attemptId,
      timestamp: context.timestamp,
      strategy: context.strategy ?? null,
      failureStage: context.stage,
      sessionContentHash: context.sessionContentHash ?? null,
      profileContentHashBefore: context.profileContentHashBefore || null,
      profileContentHashAfter:
        (context.profileContentHashAfter ?? context.profileContentHashBefore) || null,
      appliedSourceHash: context.appliedChange ? (context.sessionContentHash ?? null) : null,
      error: mergeErrorMessage
    });

    let auditFailure: string | undefined;
    if (context.stage !== "write_audit" && context.sessionContentHash) {
      try {
        await this.appendSessionMemoryMergeAuditEntry({
          attemptId: context.attemptId,
          timestamp: context.timestamp,
          sessionAgentId: descriptor.agentId,
          profileId: context.profileId,
          status: "failed",
          strategy: context.strategy ?? "seed",
          stage: context.stage,
          llmMergeSucceeded: context.llmMergeSucceeded,
          usedFallbackAppend: false,
          appliedChange: context.appliedChange,
          model: context.model,
          sessionContentHash: context.sessionContentHash,
          profileContentHashBefore: context.profileContentHashBefore,
          profileContentHashAfter:
            context.profileContentHashAfter ?? context.profileContentHashBefore,
          error: mergeErrorMessage
        });
      } catch (auditError) {
        auditFailure = `failed to append merge audit entry (${errorToMessage(auditError)})`;
      }
    } else if (context.stage === "write_audit") {
      auditFailure = `failed to append merge audit entry (${errorMessage})`;
    }

    const suffixes = [metaFailure, auditFailure].filter((value): value is string => !!value);
    const finalMessage = suffixes.length > 0 ? `${mergeErrorMessage} [${suffixes.join("; ")}]` : mergeErrorMessage;

    return new SessionMemoryMergeFailure(finalMessage, {
      strategy: context.strategy,
      stage: context.stage,
      auditPath: context.auditPath
    });
  }

  private shouldSkipSessionMemoryMergeIdempotently(
    existingMeta: SessionMeta | undefined,
    sessionContentHash: string,
    profileContentHashBefore: string
  ): boolean {
    if (!existingMeta || existingMeta.lastMemoryMergeSourceHash !== sessionContentHash) {
      return false;
    }

    if (existingMeta.lastMemoryMergeStatus === "failed") {
      return false;
    }

    if (!existingMeta.lastMemoryMergeProfileHashAfter) {
      return true;
    }

    return existingMeta.lastMemoryMergeProfileHashAfter === profileContentHashBefore;
  }

  private shouldRepairFailedPostApplyMerge(
    existingMeta: SessionMeta | undefined,
    sessionContentHash: string,
    profileContentHashBefore: string
  ): boolean {
    if (!existingMeta || existingMeta.lastMemoryMergeStatus !== "failed") {
      return false;
    }

    if (existingMeta.lastMemoryMergeAppliedSourceHash !== sessionContentHash) {
      return false;
    }

    if (
      existingMeta.lastMemoryMergeFailureStage &&
      !isPostApplyFailureStage(existingMeta.lastMemoryMergeFailureStage)
    ) {
      return false;
    }

    if (!existingMeta.lastMemoryMergeProfileHashAfter) {
      return true;
    }

    return existingMeta.lastMemoryMergeProfileHashAfter === profileContentHashBefore;
  }

  private isSessionMemoryMergeNoOp(sessionMemoryContent: string): boolean {
    if (sessionMemoryContent.trim().length === 0) {
      return true;
    }

    return this.isDefaultMemoryTemplateContent(sessionMemoryContent);
  }

  private isDefaultMemoryTemplateContent(content: string): boolean {
    const normalizedLines = normalizeMemoryTemplateLines(content);

    if (normalizedLines.length !== this.defaultMemoryTemplateNormalizedLines.length) {
      return false;
    }

    for (let index = 0; index < normalizedLines.length; index += 1) {
      if (normalizedLines[index] !== this.defaultMemoryTemplateNormalizedLines[index]) {
        return false;
      }
    }

    return true;
  }

  private async refreshDefaultMemoryTemplateNormalizedLines(): Promise<void> {
    const memoryTemplate = await this.resolvePromptWithFallback(
      "operational",
      "memory-template",
      undefined,
      DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
    );

    const normalizedLines = normalizeMemoryTemplateLines(memoryTemplate);
    if (normalizedLines.length === 0) {
      this.defaultMemoryTemplateNormalizedLines = DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES;
      return;
    }

    this.defaultMemoryTemplateNormalizedLines = normalizedLines;
  }

  private async resolveMemoryTemplateContent(profileId: string): Promise<string> {
    return this.resolvePromptWithFallback(
      "operational",
      "memory-template",
      profileId,
      DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
    );
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    await this.persistenceService.ensureMemoryFilesForBoot({
      resolveMemoryTemplateContent: (profileId) => this.resolveMemoryTemplateContent(profileId)
    });
  }

  private async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    const resolvedProfileId =
      normalizeOptionalAgentId(profileId) ??
      this.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ??
      "default";
    const memoryTemplateContent = await this.resolveMemoryTemplateContent(resolvedProfileId);

    await this.persistenceService.ensureAgentMemoryFile(memoryFilePath, memoryTemplateContent);
  }

  private async ensureProfileDirectories(profileId: string): Promise<void> {
    await this.persistenceService.ensureProfileDirectories(profileId);
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

const VALID_PERSISTED_AGENT_ROLES = new Set(["manager", "worker"]);
const VALID_PERSISTED_AGENT_STATUSES = new Set([
  "idle",
  "streaming",
  "terminated",
  "stopped",
  "error",
  "stopped_on_restart"
]);

function compareRuntimeExtensionSnapshots(
  left: AgentRuntimeExtensionSnapshot,
  right: AgentRuntimeExtensionSnapshot
): number {
  const leftRoleRank = left.role === "manager" ? 0 : 1;
  const rightRoleRank = right.role === "manager" ? 0 : 1;
  if (leftRoleRank !== rightRoleRank) {
    return leftRoleRank - rightRoleRank;
  }

  const leftProfileOrSession = left.profileId ?? left.managerId;
  const rightProfileOrSession = right.profileId ?? right.managerId;
  const byProfileOrSession = leftProfileOrSession.localeCompare(rightProfileOrSession);
  if (byProfileOrSession !== 0) {
    return byProfileOrSession;
  }

  const byManager = left.managerId.localeCompare(right.managerId);
  if (byManager !== 0) {
    return byManager;
  }

  return left.agentId.localeCompare(right.agentId);
}

function validateAgentDescriptor(value: unknown): AgentDescriptor | string {
  if (!isRecord(value)) {
    return "descriptor must be an object";
  }

  if (!isNonEmptyString(value.agentId)) {
    return "agentId must be a non-empty string";
  }

  if (typeof value.displayName !== "string") {
    return "displayName must be a string";
  }

  if (!isNonEmptyString(value.role) || !VALID_PERSISTED_AGENT_ROLES.has(value.role)) {
    return "role must be one of manager|worker";
  }

  if (!isNonEmptyString(value.managerId)) {
    return "managerId must be a non-empty string";
  }

  if (!isNonEmptyString(value.status) || !VALID_PERSISTED_AGENT_STATUSES.has(value.status)) {
    return "status must be one of idle|streaming|terminated|stopped|error|stopped_on_restart";
  }
  const normalizedStatus = normalizeAgentStatus(value.status as AgentStatusInput);

  if (!isNonEmptyString(value.createdAt)) {
    return "createdAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.updatedAt)) {
    return "updatedAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.cwd)) {
    return "cwd must be a non-empty string";
  }

  if (!isNonEmptyString(value.sessionFile)) {
    return "sessionFile must be a non-empty string";
  }

  const model = value.model;
  if (!isRecord(model)) {
    return "model must be an object";
  }

  if (!isNonEmptyString(model.provider)) {
    return "model.provider must be a non-empty string";
  }

  if (!isNonEmptyString(model.modelId)) {
    return "model.modelId must be a non-empty string";
  }

  if (!isNonEmptyString(model.thinkingLevel)) {
    return "model.thinkingLevel must be a non-empty string";
  }

  if (value.archetypeId !== undefined && typeof value.archetypeId !== "string") {
    return "archetypeId must be a string when provided";
  }

  if (
    value.sessionPurpose !== undefined &&
    value.sessionPurpose !== "cortex_review" &&
    value.sessionPurpose !== "agent_creator"
  ) {
    return 'sessionPurpose must be "cortex_review" or "agent_creator" when provided';
  }

  if (value.pinnedAt !== undefined && typeof value.pinnedAt !== "string") {
    return "pinnedAt must be a string when provided";
  }

  let normalizedProjectAgentHandle: string | undefined;
  if (value.projectAgent !== undefined) {
    if (!isRecord(value.projectAgent)) {
      return "projectAgent must be an object when provided";
    }

    if (!isNonEmptyString(value.projectAgent.handle)) {
      return "projectAgent.handle must be a non-empty string";
    }

    try {
      normalizedProjectAgentHandle = sanitizePersistedPathSegment(value.projectAgent.handle);
    } catch {
      return "projectAgent.handle must be a safe single path segment";
    }

    if (!isNonEmptyString(value.projectAgent.whenToUse)) {
      return "projectAgent.whenToUse must be a non-empty string";
    }

    if (
      value.projectAgent.systemPrompt !== undefined &&
      typeof value.projectAgent.systemPrompt !== "string"
    ) {
      return "projectAgent.systemPrompt must be a string when provided";
    }

    if (
      value.projectAgent.creatorSessionId !== undefined &&
      typeof value.projectAgent.creatorSessionId !== "string"
    ) {
      return "projectAgent.creatorSessionId must be a string when provided";
    }
  }

  if (value.agentCreatorResult !== undefined) {
    if (!isRecord(value.agentCreatorResult)) {
      return "agentCreatorResult must be an object when provided";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdAgentId)) {
      return "agentCreatorResult.createdAgentId must be a non-empty string";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdHandle)) {
      return "agentCreatorResult.createdHandle must be a non-empty string";
    }

    if (!isNonEmptyString(value.agentCreatorResult.createdAt)) {
      return "agentCreatorResult.createdAt must be a non-empty string";
    }
  }

  const descriptor = value as unknown as AgentDescriptor;
  const normalizedProjectAgent =
    descriptor.projectAgent && normalizedProjectAgentHandle && descriptor.projectAgent.handle !== normalizedProjectAgentHandle
      ? {
          ...descriptor.projectAgent,
          handle: normalizedProjectAgentHandle
        }
      : descriptor.projectAgent;

  if (descriptor.status === normalizedStatus && normalizedProjectAgent === descriptor.projectAgent) {
    return descriptor;
  }

  return {
    ...descriptor,
    status: normalizedStatus,
    ...(normalizedProjectAgent !== descriptor.projectAgent ? { projectAgent: normalizedProjectAgent } : {})
  };
}

function extractDescriptorAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isNonEmptyString(value.agentId) ? value.agentId.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseSessionNumberFromAgentId(agentId: string, profileId: string): number | undefined {
  if (!agentId.startsWith(`${profileId}${SESSION_ID_SUFFIX_SEPARATOR}`)) {
    return undefined;
  }

  const rawSessionNumber = agentId.slice(`${profileId}${SESSION_ID_SUFFIX_SEPARATOR}`.length);
  if (!/^[0-9]+$/.test(rawSessionNumber)) {
    return undefined;
  }

  const sessionNumber = Number.parseInt(rawSessionNumber, 10);
  if (!Number.isFinite(sessionNumber) || sessionNumber <= ROOT_SESSION_NUMBER) {
    return undefined;
  }

  return sessionNumber;
}

function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAgentId(input: string): string {
  const trimmed = input.trim();
  if (/[/\\\x00]/.test(trimmed)) {
    throw new Error(`agentId contains invalid characters: "${trimmed}"`);
  }

  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeOptionalAgentId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalModelId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildModelCapacityBlockKey(provider: string, modelId: string): string | undefined {
  const normalizedProvider = normalizeOptionalAgentId(provider)?.toLowerCase();
  const normalizedModelId = normalizeOptionalModelId(modelId)?.toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return undefined;
  }

  return `${normalizedProvider}/${normalizedModelId}`;
}

function resolveNextCapacityFallbackModelId(provider: string, modelId: string): string | undefined {
  const normalizedProvider = normalizeOptionalAgentId(provider)?.toLowerCase();
  const normalizedModelId = normalizeOptionalModelId(modelId)?.toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return undefined;
  }

  if (normalizedProvider !== "openai-codex") {
    return undefined;
  }

  const index = OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN.indexOf(normalizedModelId);
  if (index < 0 || index + 1 >= OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN.length) {
    return undefined;
  }

  return OPENAI_CODEX_CAPACITY_FALLBACK_CHAIN[index + 1];
}

function shouldRetrySpecialistSpawnWithFallback(
  error: unknown,
  attemptedModel: Pick<AgentModelDescriptor, "provider" | "modelId">
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const capacity = classifyRuntimeCapacityError(message);
  if (capacity.isQuotaOrRateLimit) {
    return true;
  }

  const normalizedMessage = message.trim().toLowerCase();
  const authIndicators = [
    "authentication",
    "unauthorized",
    "invalid api key",
    "api key",
    "missing auth",
    "no auth",
    "forbidden",
    "permission denied",
    "access denied",
    "oauth"
  ];

  const isAuthError = authIndicators.some((indicator) => normalizedMessage.includes(indicator));
  if (isAuthError) {
    return true;
  }

  const provider = attemptedModel.provider.trim().toLowerCase();
  const modelId = attemptedModel.modelId.trim().toLowerCase();

  return normalizedMessage.includes(provider) && normalizedMessage.includes(modelId) && normalizedMessage.includes("auth");
}

function clampModelCapacityBlockDurationMs(durationMs: number): number | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }

  const rounded = Math.round(durationMs);
  if (rounded < MODEL_CAPACITY_BLOCK_MIN_MS) {
    return MODEL_CAPACITY_BLOCK_MIN_MS;
  }

  if (rounded > MODEL_CAPACITY_BLOCK_MAX_MS) {
    return MODEL_CAPACITY_BLOCK_MAX_MS;
  }

  return rounded;
}

function normalizeThinkingLevelForProvider(provider: string, thinkingLevel: string): string {
  if (provider.trim().toLowerCase() !== "anthropic") {
    return thinkingLevel;
  }

  const normalized = thinkingLevel.trim().toLowerCase();
  if (normalized === "none") {
    return "low";
  }

  if (normalized === "xhigh" || normalized === "x-high") {
    return "high";
  }

  return thinkingLevel;
}

/** @visibleForTesting Root/profile memory composition is part of the Phase 3 ownership contract. */
export function buildSessionMemoryRuntimeView(profileMemoryContent: string, sessionMemoryContent: string): string {
  const normalizedProfileMemory = profileMemoryContent.trimEnd();
  const normalizedSessionMemory = sessionMemoryContent.trimEnd();

  return [
    "# Manager Memory (shared across all sessions — read-only reference)",
    "",
    normalizedProfileMemory,
    "",
    "---",
    "",
    "# Session Memory (this session's working memory — your writes go here)",
    "",
    normalizedSessionMemory
  ].join("\n");
}

function normalizeMemoryMergeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

function finalizeMergedMemoryContent(content: string): string {
  const normalized = normalizeMemoryMergeContent(content);
  return normalized.length > 0 ? `${normalized}\n` : "";
}

function hashMemoryMergeContent(content: string): string {
  return createHash("sha256").update(normalizeMemoryMergeContent(content)).digest("hex");
}

function isPostApplyFailureStage(stage: SessionMemoryMergeFailureStage): boolean {
  return (
    stage === "refresh_session_meta_stats" ||
    stage === "record_attempt" ||
    stage === "write_audit" ||
    stage === "save_store"
  );
}

function resolveModel(
  modelRegistry: ModelRegistry,
  descriptor: AgentModelDescriptor
): Model<Api> | undefined {
  const direct = modelRegistry.find(descriptor.provider, descriptor.modelId);
  if (direct) {
    return direct;
  }

  const fromCatalog = getModel(descriptor.provider as any, descriptor.modelId as any);
  if (fromCatalog) {
    return fromCatalog as Model<Api>;
  }

  return modelRegistry.getAll()[0];
}

function buildWorkerCompletionReport(
  agentId: string,
  history: ConversationEntryEvent[]
): { message: string; summaryTimestamp?: number; summaryKey?: string } {
  const latestSummary = findLatestWorkerCompletionSummary(history);
  if (!latestSummary) {
    return {
      message: `SYSTEM: Worker ${agentId} completed its turn.`
    };
  }

  const summaryTimestamp = parseTimestampToMillis(latestSummary.timestamp);
  const summaryKey = buildWorkerCompletionSummaryKey(latestSummary);
  const summaryText = truncateWorkerCompletionText(
    latestSummary.text,
    MAX_WORKER_COMPLETION_REPORT_CHARS
  );
  const attachmentCount = latestSummary.attachments?.length ?? 0;
  const attachmentLine =
    attachmentCount > 0
      ? `\n\nAttachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}.`
      : "";
  const turnOutcomeLine = isWorkerErrorSummary(latestSummary)
    ? `SYSTEM: Worker ${agentId} ended its turn with an error.`
    : `SYSTEM: Worker ${agentId} completed its turn.`;

  if (summaryText.length > 0) {
    return {
      message: [
        turnOutcomeLine,
        "",
        `${latestSummary.role === "system" ? "Last system message" : "Last assistant message"}:`,
        summaryText
      ].join("\n") + attachmentLine,
      summaryTimestamp,
      summaryKey
    };
  }

  if (attachmentCount > 0) {
    return {
      message: isWorkerErrorSummary(latestSummary)
        ? `SYSTEM: Worker ${agentId} ended its turn with an error and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`
        : `SYSTEM: Worker ${agentId} completed its turn and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`,
      summaryTimestamp,
      summaryKey
    };
  }

  return {
    message: turnOutcomeLine,
    summaryTimestamp,
    summaryKey
  };
}

function findLatestWorkerCompletionSummary(
  history: ConversationEntryEvent[]
): ConversationMessageEvent | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message") {
      continue;
    }

    if (entry.role !== "assistant" && entry.role !== "system") {
      continue;
    }

    const trimmedText = entry.text.trim();
    const attachmentCount = entry.attachments?.length ?? 0;
    if (trimmedText.length === 0 && attachmentCount === 0) {
      continue;
    }

    return entry;
  }

  return undefined;
}

const WORKER_ERROR_SUMMARY_PATTERNS = [
  /^⚠️\s*Worker reply failed\b/i,
  /^⚠️\s*Agent error\b/i,
  /^⚠️\s*Extension error\b/i,
  /^⚠️\s*Context guard error\b/i,
  /^⚠️\s*Compaction error\b/i,
  /^🚨\s*Context recovery failed\b/i,
];

function buildWorkerCompletionSummaryKey(entry: ConversationMessageEvent): string {
  return createHash("sha256").update(JSON.stringify({
    role: entry.role,
    text: entry.text,
    attachmentCount: entry.attachments?.length ?? 0,
    timestamp: entry.timestamp
  })).digest("hex");
}

function isWorkerErrorSummary(entry: ConversationMessageEvent): boolean {
  if (entry.role !== "system") {
    return false;
  }

  const trimmed = entry.text.trim();
  return WORKER_ERROR_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function truncateWorkerCompletionText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const availableChars = Math.max(0, maxChars - WORKER_COMPLETION_TRUNCATION_SUFFIX.length);
  let truncated = trimmed.slice(0, availableChars).trimEnd();

  const lastBreak = Math.max(truncated.lastIndexOf("\n"), truncated.lastIndexOf(" "));
  if (lastBreak > Math.floor(availableChars * 0.6)) {
    truncated = truncated.slice(0, lastBreak).trimEnd();
  }

  return `${truncated}${WORKER_COMPLETION_TRUNCATION_SUFFIX}`;
}

export function normalizeCortexUserVisiblePaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:)?(?:[\\/][^,\s`]+)+[\\/]profiles(?:[\\/][^,\s`]+)+/g, (matchedPath) => {
    const normalized = matchedPath.replace(/\\/g, "/");
    const profilesIndex = normalized.toLowerCase().lastIndexOf("/profiles/");
    if (profilesIndex < 0) {
      return matchedPath;
    }

    return normalized.slice(profilesIndex + 1);
  });
}

export function analyzeLatestCortexCloseoutNeed(
  history: ConversationEntryEvent[]
): { needsReminder: boolean; userTimestamp?: number; reason?: "missing_speak_to_user" | "stale_after_worker_progress" } {
  let latestUserIndex = -1;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type === "conversation_message" && entry.role === "user" && entry.source === "user_input") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return { needsReminder: false };
  }

  const latestUserEntry = history[latestUserIndex];
  const userTimestamp =
    latestUserEntry.type === "conversation_message"
      ? parseTimestampToMillis(latestUserEntry.timestamp)
      : undefined;

  let lastSpeakToUserTimestamp: number | undefined;
  for (let index = latestUserIndex + 1; index < history.length; index += 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message" || entry.source !== "speak_to_user") {
      continue;
    }

    const timestamp = parseTimestampToMillis(entry.timestamp);
    if (typeof timestamp === "number") {
      lastSpeakToUserTimestamp = timestamp;
    }
  }

  if (typeof lastSpeakToUserTimestamp !== "number") {
    return {
      needsReminder: true,
      userTimestamp,
      reason: "missing_speak_to_user"
    };
  }

  for (let index = latestUserIndex + 1; index < history.length; index += 1) {
    const entry = history[index];
    if (!isCortexCloseoutFollowUpEntry(entry)) {
      continue;
    }

    const timestamp = parseTimestampToMillis(entry.timestamp);
    if (typeof timestamp === "number" && timestamp > lastSpeakToUserTimestamp) {
      return {
        needsReminder: true,
        userTimestamp,
        reason: "stale_after_worker_progress"
      };
    }
  }

  return {
    needsReminder: false,
    userTimestamp
  };
}

function isCortexCloseoutFollowUpEntry(entry: ConversationEntryEvent): boolean {
  return entry.type === "agent_message" && entry.source === "agent_to_agent";
}

function parseTimestampToMillis(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolExecutionPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return safeJson(value);
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(0, maxChars);
}

function trimToMaxCharsFromEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(-maxChars);
}

function toDisplayToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (normalized.length === 0) {
    return "Unknown";
  }

  return normalized
    .split(/[\s_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readPositiveIntegerDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function readStringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined
    });
  }

  return normalized;
}

function toConversationAttachmentMetadata(
  attachments: ConversationAttachment[],
  uploadsDir: string
): ConversationAttachmentMetadata[] {
  const metadata: ConversationAttachmentMetadata[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const normalizedName = normalizeOptionalMetadataValue(attachment.fileName);
    const fileRef = resolveAttachmentFileRef(attachment.filePath, uploadsDir);
    const sizeBytes = computeAttachmentSizeBytes(attachment);

    if (isConversationTextAttachment(attachment)) {
      metadata.push({
        type: "text",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
      continue;
    }

    if (isConversationBinaryAttachment(attachment)) {
      metadata.push({
        type: "binary",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
      continue;
    }

    if (isConversationImageAttachment(attachment)) {
      metadata.push({
        type: "image",
        mimeType: attachment.mimeType,
        fileName: normalizedName,
        fileRef,
        sizeBytes
      });
    }
  }

  return metadata;
}

function toRuntimeDispatchAttachments(
  attachments: ConversationAttachment[],
  persistedAttachments: ConversationAttachment[]
): ConversationAttachment[] {
  return attachments.map((attachment, index) => {
    const persistedAttachment = persistedAttachments[index];
    const persistedPath = normalizeOptionalAttachmentPath(persistedAttachment?.filePath);
    if (!persistedAttachment || !persistedPath) {
      return attachment;
    }

    return {
      ...attachment,
      filePath: persistedPath
    };
  });
}

async function withManagerTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function computeAttachmentSizeBytes(attachment: ConversationAttachment): number | undefined {
  if (isConversationTextAttachment(attachment)) {
    return Buffer.byteLength(attachment.text, "utf8");
  }

  if (isConversationBinaryAttachment(attachment) || isConversationImageAttachment(attachment)) {
    return decodeBase64ByteLength(attachment.data);
  }

  return undefined;
}

function decodeBase64ByteLength(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  let padding = 0;
  if (trimmed.endsWith("==")) {
    padding = 2;
  } else if (trimmed.endsWith("=")) {
    padding = 1;
  }

  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveAttachmentFileRef(path: string | undefined, uploadsDir: string): string | undefined {
  const normalizedPath = normalizeOptionalAttachmentPath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const resolvedPath = resolve(normalizedPath);
  const resolvedUploadsDir = resolve(uploadsDir);
  if (dirname(resolvedPath) !== resolvedUploadsDir) {
    return undefined;
  }

  return basename(resolvedPath);
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function extractAssistantMessageText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function stripOuterCodeFence(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function formatInboundUserMessageForManager(text: string, sourceContext: MessageSourceContext): string {
  const sourceMetadataLine = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return sourceMetadataLine;
  }

  return `${sourceMetadataLine}\n\n${trimmed}`;
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel: input.channel === "telegram" ? input.channel : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel: input.channel === "telegram" ? input.channel : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

function normalizeMemoryTemplateLines(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .filter((line) => line.length > 0)
}

function escapeXmlForPreview(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isVersionedWriteToolName(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

function extractVersionedToolPath(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return extractVersionedToolPath(JSON.parse(trimmed), depth + 1);
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = extractVersionedToolPath(entry, depth + 1);
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["path", "filePath"]) {
    if (typeof record[key] === "string" && record[key].trim().length > 0) {
      return record[key].trim();
    }
  }

  for (const nestedKey of ["args", "arguments", "result", "payload", "input", "data", "preview"]) {
    if (!(nestedKey in record)) {
      continue;
    }

    const candidate = extractVersionedToolPath(record[nestedKey], depth + 1);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

async function readFileHead(filePath: string, bytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_reason?: unknown) => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

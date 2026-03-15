import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ServerEvent,
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
  SessionMeta
} from "@middleman/protocol";
import { persistConversationAttachments } from "../ws/attachment-parser.js";
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
  getCortexWorkerPromptsPath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getSessionDir,
  getSessionFilePath,
  getSessionMetaPath,
  getWorkerSessionFilePath,
  getWorkersDir,
  resolveMemoryFilePath
} from "./data-paths.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { migrateDataDirectory } from "./data-migration.js";
import { executeLLMMerge, MEMORY_MERGE_SYSTEM_PROMPT } from "./memory-merge.js";
import { PersistenceService } from "./persistence-service.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import { RuntimeFactory } from "./runtime-factory.js";
import {
  computePromptFingerprint,
  readSessionMeta,
  rebuildSessionMeta,
  updateSessionMetaStats,
  updateSessionMetaWorker,
  writeSessionMeta
} from "./session-manifest.js";
import { SecretsEnvService } from "./secrets-env-service.js";
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
} from "./message-utils.js";
import { classifyRuntimeCapacityError } from "./runtime-utils.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  parseSwarmModelPreset,
  parseSwarmReasoningLevel,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
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
  RuntimeUserMessage,
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
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this user.

Send a warm welcome via speak_to_user and explain that you orchestrate worker agents to get work done quickly and safely.

Then run a short onboarding interview. Ask:
1. What kinds of projects/tasks they expect to work on most.
2. Whether they prefer delegation-heavy execution or hands-on collaboration.
3. Which tools/integrations matter most (Slack, Telegram, cron scheduling, web search, etc.).
4. Any coding/process preferences (style conventions, testing expectations, branching/PR habits).
5. Communication style preferences (concise vs detailed, formal vs casual, update cadence).

Offer this example workflow to show what's possible:

"The Delegator" workflow:
- User describes a feature or task.
- Manager spawns a codex worker in a git worktree branch.
- Worker implements and validates (typecheck, build, tests).
- Merger agent merges the branch to main.
- Multiple independent tasks can run in parallel across separate workers.
- Use different model workers for different strengths (e.g. opus for UI polish, codex for backend).
- Manager focuses on orchestration and concise status updates.
- Memory file tracks preferences, decisions, and project context across sessions.

This is just one example — ask the user how they'd like to work and adapt to their style.

Close by asking if they want you to save their preferences to memory for future sessions.
If they agree, summarize the choices and persist them using the memory workflow.`;
const COMMON_KNOWLEDGE_MEMORY_HEADER =
  "# Common Knowledge (maintained by Cortex — read-only reference)";
const COMMON_KNOWLEDGE_INITIAL_TEMPLATE = `# Common Knowledge

> Maintained by Cortex. Injected into all agents.

## User Profile

## Working Patterns

## Quality Standards
`;

/* eslint-disable no-useless-escape */
const CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE = `# Cortex Worker Prompt Templates — v2
<!-- Cortex Worker Prompts Version: 2 -->

> Owned by Cortex. Refine these templates over time based on what produces good vs bad results from workers.

Use these templates when spawning Spark workers. Copy the relevant template, fill in the placeholders (marked with \`{{...}}\`), and send as the worker's task message.

Model selection default/fallback:
- Default extraction model: \`modelId: "gpt-5.3-codex-spark"\`
- If workers idle with provider/quota errors or emit no output, retry with \`modelId: "gpt-5.3-codex"\`
- Escalate to \`modelId: "gpt-5.4"\` for ambiguous/high-complexity synthesis

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

Use for: Reviewing a single session's new transcript content and extracting durable knowledge signals.

\`\`\`
You are a knowledge extraction worker for Cortex.

## Task
Review only the transcript delta that starts at byte offset {{BYTE_OFFSET}} in \`{{SESSION_JSONL_PATH}}\`.

Important: the \`read\` tool offset is line-based, NOT byte-based. Do NOT pass {{BYTE_OFFSET}} into \`read\` directly.

Use this two-step workflow instead:
1. Use \`bash\` with Python/Node to copy the transcript slice starting at byte offset {{BYTE_OFFSET}} into \`{{DELTA_SLICE_PATH}}\`.
2. Use the \`read\` tool on \`{{DELTA_SLICE_PATH}}\` to inspect the sliced content.

If \`{{BYTE_OFFSET}}\` is 0, you may read the original session file directly with \`read\`.

The file is JSONL — each line is a JSON object with a \`type\` field:
- \`user_message\` — what the user said (highest signal)
- \`assistant_chunk\` — what the manager said
- \`worker_message\` — worker reporting to manager
- \`tool_call\` / \`tool_result\` — tool usage

Focus on \`content\` or \`text\` fields for actual text.

## What to extract
Find durable signals such as:
- user preferences
- workflow patterns
- technical decisions
- project facts
- quality standards
- working conventions
- recurring gotchas
- cross-project patterns

## What to SKIP
- transient task details
- implementation minutiae
- secrets
- ephemeral status/progress chatter
- raw code unless it reveals a durable pattern

## Output
Write findings to \`{{OUTPUT_ARTIFACT_PATH}}\`. For each finding:

### [CATEGORY] Finding title
- **Evidence**: Brief quote or paraphrase from the session
- **Confidence**: high / medium / low
- **Classification**: inject | reference | discard
- **Scope**: common (cross-project) | profile-specific
- **Target**: common.md | profiles/{{PROFILE_ID}}/memory.md | profiles/{{PROFILE_ID}}/reference/<file>.md
- **Profile**: {{PROFILE_ID}}
- **Session**: {{SESSION_ID}}

If you find nothing worth extracting, write "No durable signals found in this segment."

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 2. Session-Memory Extraction Worker

Use for: Reviewing a session's working memory file for signals worth promoting.

\`\`\`
You are a session-memory review worker for Cortex.

## Task
Read the session memory file at \`{{SESSION_MEMORY_PATH}}\`.

For context, the current profile memory is:
{{PROFILE_MEMORY_CONTENT_OR "Profile memory is currently empty."}}

## What to look for
- decisions or conventions that have become durable
- patterns not already captured in profile memory
- corrections to existing profile memory
- architectural understanding that should persist
- gotchas worth remembering

## What to SKIP
- active task state and in-progress work items
- duplicates of existing profile memory
- speculative notes without evidence
- Cortex-internal orchestration details

## Output
Write findings to \`{{OUTPUT_ARTIFACT_PATH}}\`. For each finding:

### [CATEGORY] Finding title
- **Source**: Quote or paraphrase from session memory
- **Confidence**: high / medium / low
- **Classification**: inject | reference | discard
- **Target**: profiles/{{PROFILE_ID}}/memory.md | profiles/{{PROFILE_ID}}/reference/<file>.md
- **Action**: add | update | remove
- **Existing entry**: (if update/remove) which entry to modify

If nothing is worth promoting, write "No promotable signals in session memory."

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 3. Knowledge Synthesis Worker

Use for: Deduplicating multiple worker outputs into promotion-ready updates.

\`\`\`
You are a knowledge synthesis worker for Cortex.

## Task
Below are raw findings from multiple worker artifacts. Deduplicate, reconcile conflicts, and produce promotion-ready updates.

## Raw findings
{{PASTE_ALL_WORKER_FINDINGS_HERE}}

## Current knowledge state
{{PASTE_RELEVANT_EXISTING_KNOWLEDGE_OR "No existing entries — all findings are new."}}

## Instructions
1. Deduplicate overlapping findings.
2. Reconcile conflicts and flag tensions explicitly.
3. Only keep findings that add new durable signal.
4. Validate each finding's classification: inject | reference | discard.
5. Confirm each retained finding's target file.

## Output
Write synthesis to \`{{OUTPUT_ARTIFACT_PATH}}\` with sections:
- Updates to existing entries
- New entries to add
- Discarded

For retained findings include:
- **Classification**: inject | reference
- **Target**: target file path
- **Evidence**: supporting findings

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 4. Scan / Triage Worker

Use for: Running the scan script and returning a prioritized work queue.

\`\`\`
You are a scan and triage worker for Cortex.

## Task
Run the session scan script and return a prioritized review queue.

1. Execute: \`bash node {{SWARM_SCRIPTS_DIR}}/cortex-scan.js {{SWARM_DATA_DIR}}\`
2. Parse transcript, memory, and feedback drift.
3. Sort by largest total attention bytes first.

## Output
Write results to \`{{OUTPUT_ARTIFACT_PATH}}\`:

### Review Queue
| Priority | Profile | Session | Transcript Δ | Memory Δ | Feedback Δ | Status |
|----------|---------|---------|--------------|----------|------------|--------|
| 1 | ... | ... | ... | ... | ... | ... |

### Summary
- Sessions needing review: X
- Sessions up to date: Y
- Total attention bytes: Z

If no sessions need review, write "All sessions up to date. No reviews needed."

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 5. Feedback Telemetry Worker (Programmatic-First)

Use for: Feedback-system reviews where you want structured signal without reading whole sessions manually.

\`\`\`
You are a feedback telemetry worker for Cortex.

## Task
Use scripts and structured outputs first.

1. Run one or more telemetry scripts:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-review-queue.js {{SWARM_DATA_DIR}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-session-digest.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}}\`
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-global-summary.js {{SWARM_DATA_DIR}}\`
2. Identify high-signal anomalies.
3. Only if needed, run targeted context extraction:
   - \`node {{SWARM_SCRIPTS_DIR}}/feedback-target-context.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}} --target {{TARGET_ID}}\`

## Output
Write findings to \`{{OUTPUT_ARTIFACT_PATH}}\` with sections:
- Queue Summary
- Reliability Findings
- Priority Targets
- Recommended Next Actions

For actionable findings include:
- **Classification**: inject | reference | discard
- **Target**: target file path (if not discard)

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
- Default extraction model: gpt-5.3-codex-spark
- Fallback: gpt-5.3-codex
- Escalation: gpt-5.4

## Output
Write plan to \`{{OUTPUT_ARTIFACT_PATH}}\` with:
- execution batches
- risk flags
- synthesis plan

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
- **Recommendation**: update | move | remove | sharpen | split-to-reference
- **Detail**

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 8. Prune / Retirement Worker

Use for: Identifying knowledge entries that should be retired or demoted from inject to reference.

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
- **Action**: retire | demote-to-reference | archive | sharpen
- **Rationale**
- **Replacement text**: (if sharpen)

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## 9. Migration / Reclassification Worker

Use for: Migrating legacy \`shared/knowledge/profiles/<profileId>.md\` content into the v2 structure.

\`\`\`
You are a knowledge migration worker for Cortex.

## Task
Reclassify the legacy profile knowledge file into inject | reference | discard outputs.

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
- Inject (→ profile memory)
- Reference (→ reference docs)
- Discard
- Migration summary

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
\`\`\`

---

## Usage Notes

- Always use template 1 for transcript deltas.
- Use template 2 when session memory drift exists.
- Use template 3 when 3+ workers need synthesis.
- Use template 4 to bootstrap the review queue.
- Use template 5 for feedback-specific analysis.
- Use template 6 for large review-cycle planning.
- Use template 7 periodically for quality audits.
- Use template 8 when injected knowledge grows stale or bloated.
- Use template 9 for legacy-profile-knowledge migration/reclassification.
- Every template requires the concise callback.
- Workers classify findings as \`inject | reference | discard\`; Cortex validates before promotion.
`;
/* eslint-enable no-useless-escape */

const CORTEX_WORKER_PROMPTS_VERSION_MARKER = "<!-- Cortex Worker Prompts Version: 2 -->";
const LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES = [
  "# Cortex Worker Prompt Templates",
  "Read the session file at \\`{{SESSION_JSONL_PATH}}\\` starting from byte offset {{BYTE_OFFSET}}",
  "Return your findings as a structured list.",
  "Workers report back via \\`worker_message\\`."
] as const;

const FORKED_SESSION_MEMORY_HEADER_TEMPLATE = [
  "# Session Memory",
  '> Forked from session "${SOURCE_LABEL}" (${SOURCE_AGENT_ID}) on ${FORK_TIMESTAMP}',
  "> Parent session conversation history was duplicated at fork time.",
  ""
].join("\n");

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;

// Retain recent non-web activity while preserving the full user-facing web transcript.
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";
// Integration services add ~3 event listeners per profile (Telegram conversation_message,
// Slack conversation_message, Telegram session_lifecycle). Keep this limit above
// base listeners + (3 × expected maximum profiles).
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const IDLE_WORKER_WATCHDOG_GRACE_MS = 3_000;
const WATCHDOG_BATCH_WINDOW_MS = 750;
const WATCHDOG_BATCH_PREVIEW_LIMIT = 10;
const WATCHDOG_BACKOFF_BASE_MS = 15_000;
const WATCHDOG_BACKOFF_MAX_MS = 5 * 60_000;
const WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS = 3;
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

interface SessionRenameHistoryEntry {
  from: string;
  to: string;
  renamedAt: string;
}

interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
  consecutiveNotifications: number;
  suppressedUntilMs: number;
  circuitOpen: boolean;
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

function nowIso(): string {
  return new Date().toISOString();
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMemoryTemplateLines(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function shouldUpgradeLegacyCortexWorkerPrompts(content: string): boolean {
  if (content.includes(CORTEX_WORKER_PROMPTS_VERSION_MARKER)) {
    return false;
  }

  return LEGACY_CORTEX_WORKER_PROMPTS_SIGNATURES.every((signature) => content.includes(signature));
}

async function backupLegacyCortexWorkerPrompts(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.v1.bak`);
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

function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: cloneContextUsage(descriptor.contextUsage)
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
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly workerWatchdogState = new Map<string, WorkerWatchdogState>();
  private readonly watchdogTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchdogTimerTokens = new Map<string, number>();
  private readonly watchdogBatchQueueByManager = new Map<string, Set<string>>();
  private readonly watchdogBatchTimersByManager = new Map<string, NodeJS.Timeout>();
  private readonly modelCapacityBlocks = new Map<string, ModelCapacityBlock>();
  private readonly lastWorkerCompletionReportTimestampByAgentId = new Map<string, number>();
  private readonly conversationProjector: ConversationProjector;
  private readonly persistenceService: PersistenceService;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly skillMetadataService: SkillMetadataService;
  private readonly secretsEnvService: SecretsEnvService;
  readonly promptRegistry: PromptRegistry;

  private defaultMemoryTemplateNormalizedLines = DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES;
  private integrationContextProvider: ((profileId: string) => string) | undefined;

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
    this.promptRegistry = new FileBackedPromptRegistry({
      dataDir: this.config.paths.dataDir,
      repoDir: this.config.paths.rootDir,
      builtinArchetypesDir: join(this.config.paths.rootDir, "apps", "backend", "src", "swarm", "archetypes", "builtins"),
      builtinOperationalDir: join(this.config.paths.rootDir, "apps", "backend", "src", "swarm", "operational", "builtins")
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
    this.conversationProjector = new ConversationProjector({
      descriptors: this.descriptors,
      runtimes: this.runtimes,
      conversationEntriesByAgentId: this.conversationEntriesByAgentId,
      now: this.now,
      emitServerEvent: (eventName, payload) => {
        this.emit(eventName, payload);
      },
      logDebug: (message, details) => this.logDebug(message, details)
    });
    this.skillMetadataService = new SkillMetadataService({
      config: this.config
    });
    this.secretsEnvService = new SecretsEnvService({
      config: this.config,
      ensureSkillMetadataLoaded: () => this.skillMetadataService.ensureSkillMetadataLoaded(),
      getSkillMetadata: () => this.skillMetadataService.getSkillMetadata()
    });
    this.runtimeFactory = new RuntimeFactory({
      host: this,
      config: this.config,
      now: this.now,
      logDebug: (message, details) => this.logDebug(message, details),
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
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.handleRuntimeError(agentId, error);
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

    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }
    for (const profile of loaded.profiles ?? []) {
      this.profiles.set(profile.profileId, profile);
    }

    this.reconcileProfilesOnBoot();
    await this.ensureCortexProfile();
    await this.ensureLegacyProfileKnowledgeReferenceDocs();
    this.normalizeStreamingStatusesForBoot();
    await this.recoverMissingWorkerDescriptorsForBoot();

    await this.ensureMemoryFilesForBoot();
    await this.saveStore();
    await this.rebuildSessionManifestForBoot();

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

  listProfiles(): ManagerProfile[] {
    return this.sortedProfiles().map((profile) => ({ ...profile }));
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    return this.conversationProjector.getConversationHistory(resolvedAgentId);
  }

  async createSession(
    profileId: string,
    options?: { label?: string; name?: string }
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
    this.emitSessionLifecycle({
      action: "created",
      sessionAgentId: sessionDescriptor.agentId,
      profileId: prepared.profile.profileId,
      label: sessionDescriptor.sessionLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    return {
      profile: { ...prepared.profile },
      sessionAgent: cloneDescriptor(sessionDescriptor)
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

    await this.saveStore();
    this.emitSessionLifecycle({
      action: "deleted",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();

    return { terminatedWorkerIds };
  }

  async clearSessionConversation(agentId: string): Promise<void> {
    const descriptor = this.getRequiredSessionDescriptor(agentId);

    // Truncate the session JSONL file on disk
    if (descriptor.sessionFile) {
      try {
        await writeFile(descriptor.sessionFile, "");
      } catch {
        // File may not exist yet — that's fine
      }
    }

    // Clear in-memory conversation history
    this.conversationProjector.resetConversationHistory(agentId);

    // Notify connected clients to clear their message lists
    this.emitConversationReset(agentId, "api_reset");

    this.logDebug("session:clear", { agentId });
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
    this.emitSessionLifecycle({
      action: "renamed",
      sessionAgentId: descriptor.agentId,
      profileId: descriptor.profileId,
      label: normalizedLabel
    });
    this.emitAgentsSnapshot();
    this.emitProfilesSnapshot();
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
    options?: { label?: string }
  ): Promise<{ profile: ManagerProfile; sessionAgent: AgentDescriptor }> {
    const sourceDescriptor = this.getRequiredSessionDescriptor(sourceAgentId);
    const profile = this.profiles.get(sourceDescriptor.profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${sourceDescriptor.profileId}`);
    }

    const prepared = this.prepareSessionCreation(profile.profileId, {
      ...options,
      name: options?.label
    });
    const forkedDescriptor = prepared.sessionDescriptor;
    this.descriptors.set(forkedDescriptor.agentId, forkedDescriptor);

    await this.ensureSessionFileParentDirectory(forkedDescriptor.sessionFile);
    await this.writeInitialSessionMeta(forkedDescriptor);

    try {
      await this.copySessionHistoryForFork(sourceDescriptor.sessionFile, forkedDescriptor.sessionFile);
      await this.writeForkedSessionMemoryHeader(sourceDescriptor, forkedDescriptor.agentId);

      const runtime = await this.getOrCreateRuntimeForDescriptor(forkedDescriptor);
      forkedDescriptor.contextUsage = runtime.getContextUsage();
      this.descriptors.set(forkedDescriptor.agentId, forkedDescriptor);

      await this.saveStore();
    } catch (error) {
      await this.rollbackCreatedSession(forkedDescriptor);
      throw error;
    }

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

    const requestedModel = this.resolveSpawnModel(input, manager.model);
    const model = this.resolveSpawnModelWithCapacityFallback(requestedModel);
    const managerProfileId = manager.profileId ?? manager.agentId;
    const archetypeId = await this.resolveSpawnWorkerArchetypeId(input, agentId, managerProfileId);

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
      )
    };

    this.descriptors.set(agentId, descriptor);
    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.saveStore();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    const explicitSystemPrompt = input.systemPrompt?.trim();
    const baseSystemPrompt =
      explicitSystemPrompt && explicitSystemPrompt.length > 0
        ? explicitSystemPrompt
        : await this.resolveSystemPromptForDescriptor(descriptor);

    const runtimeSystemPrompt = this.injectWorkerIdentityContext(descriptor, baseSystemPrompt);

    const runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
    this.runtimes.set(agentId, runtime);
    this.seedWorkerCompletionReportTimestamp(agentId);

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.descriptors.set(agentId, descriptor);
    await this.updateSessionMetaForWorkerDescriptor(descriptor);
    await this.refreshSessionMetaStatsBySessionId(descriptor.managerId);

    this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

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
      await runtime.terminate({ abort: true });
      this.runtimes.delete(agentId);
    }

    if (descriptor.role === "worker") {
      this.clearWatchdogState(agentId);
      this.lastWorkerCompletionReportTimestampByAgentId.delete(agentId);
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

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      this.clearWatchdogState(descriptor.agentId);

      if (isNonRunningAgentStatus(descriptor.status)) {
        continue;
      }

      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        await runtime.stopInFlight({ abort: true });
      } else {
        descriptor.status = transitionAgentStatus(descriptor.status, "idle");
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        await this.updateSessionMetaForWorkerDescriptor(descriptor);
        this.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);
      }

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (!isNonRunningAgentStatus(target.status)) {
      const managerRuntime = this.runtimes.get(target.agentId);
      if (managerRuntime) {
        await managerRuntime.stopInFlight({ abort: true });
      } else {
        target.status = transitionAgentStatus(target.status, "idle");
        target.updatedAt = this.now();
        this.descriptors.set(target.agentId, target);
        this.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      }

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
    if (normalizedRequestedName === CORTEX_PROFILE_ID && this.hasCortexDescriptor()) {
      throw new Error("Cortex manager already exists");
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

    const profile: ManagerProfile = {
      profileId: descriptor.agentId,
      displayName: descriptor.displayName,
      defaultSessionAgentId: descriptor.agentId,
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.createdAt
    };

    this.descriptors.set(descriptor.agentId, descriptor);
    this.profiles.set(profile.profileId, profile);

    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        await this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      this.profiles.delete(profile.profileId);
      await rm(getSessionMetaPath(this.config.paths.dataDir, profile.profileId, descriptor.agentId), { force: true });
      throw error;
    }

    this.runtimes.set(managerId, runtime);

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;
    this.descriptors.set(managerId, descriptor);

    await this.captureSessionRuntimePromptMeta(descriptor);
    await this.refreshSessionMetaStats(descriptor);
    await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profile.profileId);
    await this.saveStore();

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

    for (const session of sessions) {
      session.model = { ...modelDescriptor };
      // Intentionally do NOT bump updatedAt — model changes are config updates,
      // not user-visible activity, and bumping would scramble session sort order.
      this.descriptors.set(session.agentId, session);
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:update_model", {
      managerId,
      modelPreset,
      reasoningLevel,
      updatedSessions: sessions.map((s) => s.agentId)
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
    const archetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    const archetypeEntry = await this.promptRegistry.resolveEntry("archetype", archetypeId, resolvedProfileId);
    if (!archetypeEntry) {
      throw new Error(`Prompt not found: archetype/${archetypeId}`);
    }

    let systemPrompt = archetypeEntry.content;
    let integrationContextAdded = false;

    if (this.integrationContextProvider) {
      try {
        const integrationContext = this.integrationContextProvider(resolvedProfileId).trim();
        if (integrationContext) {
          systemPrompt = `${systemPrompt}\n\n${integrationContext}`;
          integrationContextAdded = true;
        }
      } catch (error) {
        this.logDebug("manager:integration_context:error", {
          agentId: descriptor.agentId,
          profileId: resolvedProfileId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const sections: PromptPreviewSection[] = [
      {
        label: "System Prompt",
        source: integrationContextAdded
          ? `${archetypeEntry.sourcePath} (+ integration context)`
          : archetypeEntry.sourcePath,
        content: systemPrompt
      }
    ];

    const memoryResources = await this.getMemoryRuntimeResources(descriptor);
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

    const skillMetadataByPath = new Map(
      this.skillMetadataService.getSkillMetadata().map((metadata) => [metadata.path, metadata])
    );
    const seenSkillPaths = new Set<string>();
    for (const skillPath of memoryResources.additionalSkillPaths) {
      if (seenSkillPaths.has(skillPath)) {
        continue;
      }
      seenSkillPaths.add(skillPath);

      try {
        const skillMetadata = skillMetadataByPath.get(skillPath);
        sections.push({
          label: skillMetadata ? `Skill: ${skillMetadata.skillName}` : "Skill",
          source: skillPath,
          content: await readFile(skillPath, "utf8")
        });
      } catch (error) {
        this.logDebug("prompt:preview:skill_read:error", {
          profileId: resolvedProfileId,
          path: skillPath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
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

    while (this.descriptors.has(sessionAgentId)) {
      nextSessionNumber += 1;
      sessionAgentId = `${profileId}${SESSION_ID_SUFFIX_SEPARATOR}${nextSessionNumber}`;
    }

    return {
      agentId: sessionAgentId,
      sessionNumber: nextSessionNumber
    };
  }

  private generateUniqueSessionAgentId(baseAgentId: string): string {
    let candidate = baseAgentId;
    let suffix = 2;

    while (this.descriptors.has(candidate)) {
      candidate = `${baseAgentId}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private prepareSessionCreation(
    profileId: string,
    options?: { label?: string; name?: string }
  ): { profile: ManagerProfile; sessionDescriptor: AgentDescriptor; sessionNumber: number } {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
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

      sessionAgentId = this.generateUniqueSessionAgentId(slug);
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
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: templateDescriptor.cwd,
      model: { ...templateDescriptor.model },
      sessionFile: getSessionFilePath(this.config.paths.dataDir, profile.profileId, sessionAgentId)
    };

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

    for (const workerDescriptor of this.getWorkersForManager(agentId)) {
      terminatedWorkerIds.push(workerDescriptor.agentId);
      await this.terminateDescriptor(workerDescriptor, { abort: true, emitStatus: true });
      if (options.deleteWorkers) {
        this.descriptors.delete(workerDescriptor.agentId);
      }
      this.conversationProjector.deleteConversationHistory(workerDescriptor.agentId, workerDescriptor.sessionFile);
    }

    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await runtime.terminate({ abort: true });
      this.runtimes.delete(agentId);
    }

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

  private async copySessionHistoryForFork(sourceSessionFile: string, targetSessionFile: string): Promise<void> {
    await mkdir(dirname(targetSessionFile), { recursive: true });

    try {
      await copyFile(sourceSessionFile, targetSessionFile);
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }

      await writeFile(targetSessionFile, "", "utf8");
    }
  }

  private async writeForkedSessionMemoryHeader(
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string
  ): Promise<void> {
    const sourceLabel = sourceDescriptor.sessionLabel ?? sourceDescriptor.agentId;
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const headerTemplate = await this.resolvePromptWithFallback(
      "operational",
      "forked-session-header",
      profileId,
      FORKED_SESSION_MEMORY_HEADER_TEMPLATE
    );
    const header = resolvePromptVariables(headerTemplate, {
      SOURCE_LABEL: sourceLabel,
      SOURCE_AGENT_ID: sourceDescriptor.agentId,
      FORK_TIMESTAMP: this.now()
    });

    const forkedMemoryPath = this.getAgentMemoryPath(forkedSessionAgentId);
    await mkdir(dirname(forkedMemoryPath), { recursive: true });
    await writeFile(forkedMemoryPath, header, "utf8");
    await this.refreshSessionMetaStatsBySessionId(forkedSessionAgentId);
  }

  private async rollbackCreatedSession(descriptor: AgentDescriptor): Promise<void> {
    try {
      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        await runtime.terminate({ abort: true });
        this.runtimes.delete(descriptor.agentId);
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

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = await this.getOrCreateRuntimeForDescriptor(target);

    const isWorkerReportToManager =
      sender.role === "worker" && target.role === "manager" && sender.managerId === target.agentId;
    const watchdogTurnSeqAtDispatch = isWorkerReportToManager
      ? this.getOrCreateWorkerWatchdogState(sender.agentId).turnSeq
      : undefined;

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const receipt = await runtime.sendMessage(modelMessage, delivery);

    if (isWorkerReportToManager && watchdogTurnSeqAtDispatch !== undefined) {
      const watchdogState = this.getOrCreateWorkerWatchdogState(sender.agentId);
      if (watchdogState.turnSeq === watchdogTurnSeqAtDispatch) {
        watchdogState.reportedThisTurn = true;
        watchdogState.consecutiveNotifications = 0;
        watchdogState.suppressedUntilMs = 0;
        watchdogState.circuitOpen = false;
        this.workerWatchdogState.set(sender.agentId, watchdogState);
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

    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
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
      textPreview: previewForLog(text)
    });

    return {
      targetContext: resolvedTargetContext
    };
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

    const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = options?.customInstructions?.trim() || undefined;

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

    const runtime = await this.getOrCreateRuntimeForDescriptor(descriptor);

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    this.logDebug("manager:smart_compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext
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
      const result = await runtime.smartCompact();

      if (result.compactionSucceeded) {
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
        const reason = result.compactionFailureReason ?? "unknown error";
        this.emitConversationMessage({
          type: "conversation_message",
          agentId,
          role: "system",
          text: `Smart compaction finished but context was not reduced (${reason}). The handoff note was written and a resume prompt was sent, but compaction did not succeed.`,
          timestamp: this.now(),
          source: "system",
          sourceContext
        });
      }

      this.logDebug("manager:smart_compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api",
        compactionSucceeded: result.compactionSucceeded,
        compactionFailureReason: result.compactionFailureReason
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

  setIntegrationContextProvider(provider?: (profileId: string) => string): void {
    this.integrationContextProvider = provider;
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    return this.secretsEnvService.listSettingsEnv();
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

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.conversationProjector.emitConversationMessage(event);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.conversationProjector.emitAgentMessage(event);
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.conversationProjector.emitConversationReset(agentId, reason);
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

  private sortedProfiles(): ManagerProfile[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.profiles.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.profileId === configuredManagerId) return -1;
        if (b.profileId === configuredManagerId) return 1;
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

  private async ensureCortexProfile(): Promise<void> {
    if (this.hasCortexDescriptor()) {
      await this.ensureCommonKnowledgeFile();
      await this.ensureCortexWorkerPromptsFile();
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
      model: this.resolveDefaultModelDescriptor(),
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

    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);
    await this.ensureAgentMemoryFile(this.getAgentMemoryPath(descriptor.agentId), profile.profileId);
    await this.ensureAgentMemoryFile(getProfileMemoryPath(this.config.paths.dataDir, profile.profileId), profile.profileId);
    await this.writeInitialSessionMeta(descriptor);
    await this.refreshSessionMetaStats(descriptor);
    await this.ensureCommonKnowledgeFile();
    await this.ensureCortexWorkerPromptsFile();

    this.logDebug("cortex:profile:auto_created", {
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID
    });
  }

  private async ensureLegacyProfileKnowledgeReferenceDocs(): Promise<void> {
    await Promise.all(
      this.sortedProfiles().map(async (profile) => {
        await migrateLegacyProfileKnowledgeToReferenceDoc(this.config.paths.dataDir, profile.profileId);
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

      await backupLegacyCortexWorkerPrompts(workerPromptsPath);
      await writeFile(workerPromptsPath, workerPromptTemplate, "utf8");
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
    const existingRuntime = this.runtimes.get(descriptor.agentId);
    if (existingRuntime) {
      return existingRuntime;
    }

    await this.ensureSessionFileParentDirectory(descriptor.sessionFile);

    const runtime = await this.createRuntimeForDescriptor(
      descriptor,
      await this.resolveSystemPromptForDescriptor(descriptor)
    );

    const latestDescriptor = this.descriptors.get(descriptor.agentId);
    if (!latestDescriptor || isNonRunningAgentStatus(latestDescriptor.status)) {
      await runtime.terminate({ abort: true });
      throw new Error(`Target agent is not running: ${descriptor.agentId}`);
    }

    const concurrentRuntime = this.runtimes.get(descriptor.agentId);
    if (concurrentRuntime) {
      await runtime.terminate({ abort: true });
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
      await this.captureSessionRuntimePromptMeta(latestDescriptor);
      await this.refreshSessionMetaStats(latestDescriptor);
    } else {
      await this.updateSessionMetaForWorkerDescriptor(latestDescriptor);
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

  private async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;

    if (descriptor.role === "manager") {
      const managerArchetypeId = descriptor.archetypeId
        ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
        : MANAGER_ARCHETYPE_ID;
      let prompt = await this.promptRegistry.resolve("archetype", managerArchetypeId, profileId);

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

    if (
      (normalizedExplicitTarget.channel === "slack" ||
        normalizedExplicitTarget.channel === "telegram") &&
      !normalizedExplicitTarget.channelId
    ) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"'
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
    if (descriptor.role === "worker") {
      this.clearWatchdogState(descriptor.agentId);
      this.lastWorkerCompletionReportTimestampByAgentId.delete(descriptor.agentId);
    }

    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      await runtime.terminate({ abort: options.abort });
      this.runtimes.delete(descriptor.agentId);
    }

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
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    return this.runtimeFactory.createRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async handleRuntimeStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    const contextUsageChanged = !areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage);
    let shouldPersist = false;

    if (contextUsageChanged) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    const nextStatus = transitionAgentStatus(descriptor.status, status);
    const statusChanged = descriptor.status !== nextStatus;
    if (statusChanged) {
      descriptor.status = nextStatus;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
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
  }

  private async handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void> {
    this.captureConversationEventFromRuntime(agentId, event);

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
    }

    if (!this.config.debug) return;

    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: event.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: previewForLog(safeJson(event.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: previewForLog(safeJson(event.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${event.type}`, {
          role: extractRole(event.message),
          textPreview: previewForLog(extractMessageText(event.message) ?? "")
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

  private async handleRuntimeError(agentId: string, error: RuntimeErrorEvent): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    this.maybeRecordModelCapacityBlock(agentId, descriptor, {
      ...error,
      message
    });

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

    const text =
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
          : droppedPendingCount && droppedPendingCount > 0
            ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
            : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`;

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
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? this.descriptors.get(agentId)?.contextUsage);
    const runtime = this.runtimes.get(agentId);
    const contextRecoveryInProgress = runtime?.isContextRecoveryInProgress?.() === true;
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {}),
      ...(contextRecoveryInProgress ? { contextRecoveryInProgress } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listAgents()
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

  private async captureSessionRuntimePromptMeta(descriptor: AgentDescriptor): Promise<void> {
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

  private async updateSessionMetaForWorkerDescriptor(descriptor: AgentDescriptor): Promise<void> {
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
          status: this.mapWorkerStatusForMeta(descriptor.status),
          createdAt: descriptor.createdAt,
          terminatedAt: descriptor.status === "terminated" ? descriptor.updatedAt : null,
          tokens: {
            input:
              typeof descriptor.contextUsage?.tokens === "number"
                ? Math.max(0, Math.round(descriptor.contextUsage.tokens))
                : null,
            output: null
          }
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

  private async handleRuntimeAgentEnd(agentId: string): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    if (this.isRuntimeInContextRecovery(agentId)) {
      const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
      watchdogState.turnSeq += 1;
      watchdogState.reportedThisTurn = false;
      this.workerWatchdogState.set(agentId, watchdogState);

      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    const reportedThisTurn = watchdogState.reportedThisTurn;

    // Reset watchdog state for the next agentic loop.
    watchdogState.turnSeq += 1;
    watchdogState.reportedThisTurn = false;
    const turnSeq = watchdogState.turnSeq;
    this.workerWatchdogState.set(agentId, watchdogState);

    if (reportedThisTurn) {
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const autoReported = await this.tryAutoReportWorkerCompletion(descriptor);
    if (autoReported) {
      const postSendState = this.getOrCreateWorkerWatchdogState(agentId);
      if (postSendState.turnSeq === turnSeq) {
        postSendState.reportedThisTurn = true;
        this.workerWatchdogState.set(agentId, postSendState);

        // Re-arm for the next runtime end callback.
        postSendState.reportedThisTurn = false;
        this.workerWatchdogState.set(agentId, postSendState);
      }

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

  private seedWorkerCompletionReportTimestamp(agentId: string): void {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    this.lastWorkerCompletionReportTimestampByAgentId.set(agentId, parseTimestampToMillis(this.now()) ?? Date.now());
  }

  private async tryAutoReportWorkerCompletion(descriptor: AgentDescriptor): Promise<boolean> {
    if (descriptor.role !== "worker") {
      return false;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return false;
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
      return false;
    }

    const workerRuntime = this.runtimes.get(descriptor.agentId);
    if (!workerRuntime) {
      this.logDebug("worker:completion_report:skip_worker_runtime_missing", {
        workerAgentId: descriptor.agentId,
        managerId
      });
      return false;
    }

    if (workerRuntime.getStatus() !== "idle" || workerRuntime.getPendingCount() > 0) {
      this.logDebug("worker:completion_report:skip_worker_runtime_active", {
        workerAgentId: descriptor.agentId,
        managerId,
        workerStatus: workerRuntime.getStatus(),
        pendingCount: workerRuntime.getPendingCount()
      });
      return false;
    }

    const report = buildWorkerCompletionReport(descriptor.agentId, this.getConversationHistory(descriptor.agentId));
    const lastReportedTimestamp = this.lastWorkerCompletionReportTimestampByAgentId.get(descriptor.agentId);

    const hasFreshSummary =
      typeof report.summaryTimestamp === "number" &&
      (typeof lastReportedTimestamp !== "number" || report.summaryTimestamp > lastReportedTimestamp);

    const message = hasFreshSummary
      ? report.message
      : `SYSTEM: Worker ${descriptor.agentId} completed its turn.`;

    try {
      await this.sendMessage(managerId, managerId, message, "auto", {
        origin: "internal"
      });

      if (hasFreshSummary && typeof report.summaryTimestamp === "number") {
        this.lastWorkerCompletionReportTimestampByAgentId.set(descriptor.agentId, report.summaryTimestamp);
      }

      this.logDebug("worker:completion_report:sent", {
        workerAgentId: descriptor.agentId,
        managerId,
        includedSummary: hasFreshSummary,
        summaryTimestamp: hasFreshSummary ? report.summaryTimestamp : undefined,
        textPreview: previewForLog(message)
      });

      return true;
    } catch (error) {
      this.logDebug("worker:completion_report:error", {
        workerAgentId: descriptor.agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
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

    this.enqueueWatchdogForBatch(descriptor.managerId, descriptor.agentId);
  }

  private enqueueWatchdogForBatch(managerId: string, workerId: string): void {
    let queue = this.watchdogBatchQueueByManager.get(managerId);
    if (!queue) {
      queue = new Set<string>();
      this.watchdogBatchQueueByManager.set(managerId, queue);
    }
    queue.add(workerId);

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

    const queuedWorkerIds = this.watchdogBatchQueueByManager.get(managerId);
    this.watchdogBatchQueueByManager.delete(managerId);

    if (!queuedWorkerIds || queuedWorkerIds.size === 0) {
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

    for (const workerId of queuedWorkerIds) {
      const workerDescriptor = this.descriptors.get(workerId);
      if (!workerDescriptor || workerDescriptor.role !== "worker" || workerDescriptor.managerId !== managerId) {
        continue;
      }

      if (workerDescriptor.status !== "idle") {
        continue;
      }

      if (this.isRuntimeInContextRecovery(workerId)) {
        continue;
      }

      const watchdogState = this.workerWatchdogState.get(workerId);
      if (!watchdogState || watchdogState.reportedThisTurn || watchdogState.circuitOpen) {
        continue;
      }

      if (nowMs < watchdogState.suppressedUntilMs) {
        continue;
      }

      eligibleWorkerIds.push(workerId);
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
    this.workerWatchdogState.delete(agentId);
    this.watchdogTimerTokens.delete(agentId);

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

  protected async executeSessionMemoryLLMMerge(
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ): Promise<{ mergedContent: string; model: string }> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.config);
    const authStorage = AuthStorage.create(authFilePath);
    const modelRegistry = new ModelRegistry(authStorage);
    const model = resolveModel(modelRegistry, descriptor.model);

    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId} for memory merge.`
      );
    }

    const apiKey = await modelRegistry.getApiKey(model);
    const memoryMergePrompt = await this.resolvePromptWithFallback(
      "operational",
      "memory-merge",
      descriptor.profileId ?? descriptor.managerId,
      MEMORY_MERGE_SYSTEM_PROMPT
    );
    const mergedContent = await executeLLMMerge(model, profileMemoryContent, sessionMemoryContent, {
      apiKey,
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

  const descriptor = value as unknown as AgentDescriptor;
  if (descriptor.status === normalizedStatus) {
    return descriptor;
  }

  return {
    ...descriptor,
    status: normalizedStatus
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
): { message: string; summaryTimestamp?: number } {
  const latestSummary = findLatestWorkerCompletionSummary(history);
  if (!latestSummary) {
    return {
      message: `SYSTEM: Worker ${agentId} completed its turn.`
    };
  }

  const summaryText = truncateWorkerCompletionText(
    latestSummary.text,
    MAX_WORKER_COMPLETION_REPORT_CHARS
  );
  const attachmentCount = latestSummary.attachments?.length ?? 0;
  const attachmentLine =
    attachmentCount > 0
      ? `\n\nAttachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}.`
      : "";

  if (summaryText.length > 0) {
    return {
      message: [
        `SYSTEM: Worker ${agentId} completed its turn.`,
        "",
        `${latestSummary.role === "system" ? "Last system message" : "Last assistant message"}:`,
        summaryText
      ].join("\n") + attachmentLine,
      summaryTimestamp: parseTimestampToMillis(latestSummary.timestamp)
    };
  }

  if (attachmentCount > 0) {
    return {
      message: `SYSTEM: Worker ${agentId} completed its turn and generated ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}.`,
      summaryTimestamp: parseTimestampToMillis(latestSummary.timestamp)
    };
  }

  return {
    message: `SYSTEM: Worker ${agentId} completed its turn.`
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
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
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

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

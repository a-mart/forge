import { createNativeSecureBashTool } from "../../secure-sessions/runtime/native-secure-bash-tool.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ForgeExtensionHost } from "../../forge-extension-host.js";
import type { ProjectExecutableTrustPlan } from "../../project-executable-trust.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { SkillMetadata } from "../../skills/skill-metadata-service.js";
import { planRuntimeTools } from "../runtime-tool-plan.js";
import { assertClaudeSetup, claudeRuntimeEnvironment, resolveClaudeExecutable } from "./claude-runtime-environment.js";
import { ClaudeAgentRuntime } from "./claude-agent-runtime.js";
import { TaskNotesStore } from "../../task-notes-store.js";
import { createTaskNotesTool } from "../../task-notes-tool.js";
import type { ObservabilityFacade } from "../../../observability/observability-types.js";
import { recordRuntimePromptAndCreation, summarizeRuntimeTools } from "../runtime-observability-capture.js";

interface Dependencies {
  config: SwarmConfig;
  host: SwarmToolHost;
  forgeExtensionHost: ForgeExtensionHost;
  observability?: ObservabilityFacade;
  resolveProjectExecutableTrustPlan(options: { descriptor: AgentDescriptor; sessionDescriptor?: AgentDescriptor }): Promise<ProjectExecutableTrustPlan>;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string }; additionalSkillPaths: string[]; skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
}

export class ClaudeRuntimeCreator {
  constructor(private readonly deps: Dependencies) {}

  async create(options: { descriptor: AgentDescriptor; systemPrompt: string; runtimeToken: number;
    callbacks: SwarmRuntimeCallbacks; creationOptions?: RuntimeCreationOptions }): Promise<SwarmAgentRuntime> {
    const { descriptor } = options;
    if (descriptor.role !== "manager" || descriptor.sessionSurface === "collab" || descriptor.collab || descriptor.sessionPurpose || descriptor.internalWorkerKind) {
      throw new Error("Claude native is available for ordinary local Builder manager sessions.");
    }
    const trust = await this.deps.resolveProjectExecutableTrustPlan({ descriptor, sessionDescriptor: descriptor });
    const prepared = await this.deps.forgeExtensionHost.prepareRuntimeBindings({ descriptor, sessionDescriptor: descriptor,
      runtimeType: "claude", runtimeToken: options.runtimeToken, projectExecutableTrustPlan: trust });
    const { swarmTools } = planRuntimeTools({ host: this.deps.host, descriptor,
      forgeExtensionHost: this.deps.forgeExtensionHost, preparedForgeBindings: prepared });
    // Resolve authority per command so a secret grant never interrupts native work.
    const tools = [...swarmTools, createNativeSecureBashTool(descriptor,
      actor => this.deps.host.getSecureRuntimeBinding?.(actor))];
    if (descriptor.profileId && tools.some(tool => tool.name === "history")) {
      tools.push(createTaskNotesTool(new TaskNotesStore({ dataDir: this.deps.config.paths.dataDir }).forActor({
        profileId: descriptor.profileId, sessionAgentId: descriptor.agentId, actorAgentId: descriptor.agentId,
      })));
    }
    const [memory, contextFiles, agentsFiles] = await Promise.all([
      this.deps.getMemoryRuntimeResources(descriptor), this.deps.getSwarmContextFiles(descriptor.cwd), readAgentInstructions(descriptor.cwd),
    ]);
    const skills = memory.skillMetadata.map(skill => `- ${skill.skillName}: ${skill.description ?? ""} (file: ${skill.path})`).join("\n");
    const secureSessionsEnabled = this.deps.host.isSecureSessionsEnabledForAgent?.(descriptor.agentId) !== false;
    const systemPrompt = [options.systemPrompt,
      "Forge integration tools are in the mcp__forge__ tool namespace. Keep native coding tools and native context management. Use Forge workers for the configured roster; do not start a second coordination system.",
      secureSessionsEnabled
        ? "For credentialed work, when the Secure Sessions tools are available, inspect mcp__forge__secure_session_status and use mcp__forge__secure_bash with the exact granted aliases. Forge delivers values privately to that command and filters its output. Never ask for values in chat, copy them into files in the workspace, or use native shell/read tools to inspect credential material. Ordinary coding remains on native tools. For SSH password login use an SSH_ASKPASS binding; for a password needed after login, use a separate environment or stdin binding and pipe it to the remote program (such as sudo -S), keeping values out of command text. Browser login delivery is not supported."
        : "Secure Sessions are disabled for this project. Use native tools and the normal host SSH configuration and authentication for authorized SSH, SCP, Git, and other host commands. Do not require Secure Sessions, secret grants, or secure_bash for that work. The Secure Sessions tool definitions remain registered for native runtime compatibility, but they do not indicate availability or impose a requirement to use them. Do not call them while the project setting is disabled. Never print credential material or ask for secret values in chat.",
      memory.memoryContextFile.content ? `<forge_memory path=${JSON.stringify(memory.memoryContextFile.path)}>\n${memory.memoryContextFile.content}\n</forge_memory>` : "",
      ...[...agentsFiles, ...contextFiles].map(file => `<forge_project_context path=${JSON.stringify(file.path)}>\n${file.content}\n</forge_project_context>`),
      skills ? `<forge_skills>\nRead a relevant skill's file before using it.\n${skills}\n</forge_skills>` : "",
    ].filter(Boolean).join("\n\n");
    const env = await claudeRuntimeEnvironment(this.deps.config);
    const executable = await resolveClaudeExecutable();
    await assertClaudeSetup(executable, env);
    const runtime = await ClaudeAgentRuntime.create({ descriptor, callbacks: options.callbacks,
      systemPrompt, env, executable, projectTrusted: trust.trusted, tools, host: this.deps.host,
      creationOptions: options.creationOptions });
    if (prepared) this.deps.forgeExtensionHost.activateRuntimeBindings(prepared);
    recordRuntimePromptAndCreation({ observability: this.deps.observability, descriptor,
      runtimeToken: options.runtimeToken, runtimeType: "claude", forgeResolvedPrompt: options.systemPrompt,
      finalSystemPrompt: systemPrompt, activeTools: summarizeRuntimeTools(tools),
      metadata: { promptRole: "system_append", nativeBaseInstructions: "preserved", nativeTools: "owned_by_claude" },
    });
    return runtime;
  }
}

/** Claude discovers CLAUDE.md; Forge also honors the repository's AGENTS.md contract. */
async function readAgentInstructions(cwd: string): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  let directory = cwd;
  while (true) {
    const path = join(directory, "AGENTS.md");
    try { result.unshift({ path, content: await readFile(path, "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return result;
}

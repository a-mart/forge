import { lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type {
  ProjectResourceExecutableSurface,
  ProjectResourceInventorySection,
  ProjectResourceMutationResponse,
  ProjectResourceOverrideRequest,
  ProjectResourcesSnapshotResponse,
  ProjectResourceSeedRequest,
  ProjectResourceTrustRequest,
  ActivateRepoProjectAgentRequest
} from "@forge/protocol";
import { scanRepoProjectAgentDefinitions } from "../../../swarm/repo-project-agent-definitions.js";
import { ProjectResourceSettingsStore } from "../../../swarm/project-resource-settings.js";
import { ProjectWorkspaceResolver, type ProjectWorkspaceResolution } from "../../../swarm/project-workspace-resolver.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../../../swarm/types.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PROJECT_RESOURCES_ENDPOINT_PATH = "/api/settings/project-resources";
const PROJECT_RESOURCES_OVERRIDE_ENDPOINT_PATH = "/api/settings/project-resources/override";
const PROJECT_RESOURCES_TRUST_ENDPOINT_PATH = "/api/settings/project-resources/trust";
const PROJECT_RESOURCES_SEED_ENDPOINT_PATH = "/api/settings/project-resources/seed";
const PROJECT_RESOURCES_PROJECT_AGENT_ACTIVATE_ENDPOINT_PATH = "/api/settings/project-resources/project-agents/activate";
const PROJECT_RESOURCES_METHODS = "GET, PUT, POST, OPTIONS";
const MAX_INVENTORY_ITEMS = 50;
const MAX_INVENTORY_ENTRIES = 1000;

export function createProjectResourceRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;
  const dataDir = swarmManager.getConfig().paths.dataDir;
  const settingsStore = new ProjectResourceSettingsStore(dataDir);
  const resolver = new ProjectWorkspaceResolver({ dataDir, settingsStore });

  return [
    {
      methods: PROJECT_RESOURCES_METHODS,
      matches: (pathname) =>
        pathname === PROJECT_RESOURCES_ENDPOINT_PATH ||
        pathname === PROJECT_RESOURCES_OVERRIDE_ENDPOINT_PATH ||
        pathname === PROJECT_RESOURCES_TRUST_ENDPOINT_PATH ||
        pathname === PROJECT_RESOURCES_SEED_ENDPOINT_PATH ||
        pathname === PROJECT_RESOURCES_PROJECT_AGENT_ACTIVATE_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        try {
          if (request.method === "OPTIONS") {
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            response.statusCode = 204;
            response.end();
            return;
          }

          const pathname = requestUrl.pathname;
          if (pathname === PROJECT_RESOURCES_ENDPOINT_PATH && request.method === "GET") {
            const context = resolveContextFromQuery(swarmManager, requestUrl);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, snapshot as unknown as Record<string, unknown>);
            return;
          }

          if (pathname === PROJECT_RESOURCES_OVERRIDE_ENDPOINT_PATH && request.method === "PUT") {
            const body = parseOverrideRequest(await readJsonBody(request));
            const context = resolveContextFromBody(swarmManager, body);
            const before = await resolver.resolve(context);
            const forgeDir = body.forgeDir === null ? null : resolve(body.forgeDir);
            if (before.warning) {
              sendCorsJson(request, response, 400, { error: before.warning });
              return;
            }
            if (forgeDir !== null) {
              const overrideCheck = await new ProjectWorkspaceResolver({ dataDir, settingsStore: createOverrideProbeStore(before.workspaceKey, forgeDir) }).resolve(context);
              if (!overrideCheck.override?.valid) {
                sendCorsJson(request, response, 400, { error: overrideCheck.override?.error ?? "Invalid .forge override directory" });
                return;
              }
            }
            await settingsStore.setOverride(before.workspaceKey, forgeDir);
            await swarmManager.applyProjectResourceWorkspaceChange(before.workspaceKey);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            const payload: ProjectResourceMutationResponse = { success: true, snapshot };
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, payload as unknown as Record<string, unknown>);
            return;
          }

          if (pathname === PROJECT_RESOURCES_TRUST_ENDPOINT_PATH && request.method === "PUT") {
            const body = parseTrustRequest(await readJsonBody(request));
            const context = resolveContextFromBody(swarmManager, body);
            const resolution = await resolver.resolve(context);
            if (!resolution.effectiveForgeDirRealpath || !resolution.trust.key) {
              sendCorsJson(request, response, 400, { error: "No effective .forge directory is available for this workspace." });
              return;
            }
            await settingsStore.setTrust(resolution.trust.key, body.action);
            await swarmManager.applyProjectResourceTrustChange(resolution.trust.key);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            const payload: ProjectResourceMutationResponse = { success: true, snapshot };
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, payload as unknown as Record<string, unknown>);
            return;
          }

          if (pathname === PROJECT_RESOURCES_PROJECT_AGENT_ACTIVATE_ENDPOINT_PATH && request.method === "POST") {
            const body = parseActivateRepoProjectAgentRequest(await readJsonBody(request));
            const result = await swarmManager.activateRepoProjectAgent(body);
            const context = resolveContextFromBody(swarmManager, body);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            const payload: ProjectResourceMutationResponse = {
              success: true,
              snapshot,
              agentId: result.agentId,
              projectAgent: result.projectAgent
            } as ProjectResourceMutationResponse & { agentId: string; projectAgent: unknown };
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, payload as unknown as Record<string, unknown>);
            return;
          }

          if (pathname === PROJECT_RESOURCES_SEED_ENDPOINT_PATH && request.method === "POST") {
            const body = parseSeedRequest(await readJsonBody(request));
            const context = resolveContextFromBody(swarmManager, body);
            const before = await resolver.resolve(context);
            if (before.warning) {
              sendCorsJson(request, response, 400, { error: before.warning });
              return;
            }
            await seedProjectForgeScaffold(before);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            const payload: ProjectResourceMutationResponse = { success: true, snapshot };
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, payload as unknown as Record<string, unknown>);
            return;
          }

          response.setHeader("Allow", PROJECT_RESOURCES_METHODS);
          sendCorsJson(request, response, 405, { error: "Method Not Allowed" });
        } catch (error) {
          sendCorsJson(request, response, 400, { error: error instanceof Error ? error.message : "Project resource request failed" });
        }
      }
    }
  ];
}

async function buildSnapshot(options: {
  resolver: ProjectWorkspaceResolver;
  settingsStore: ProjectResourceSettingsStore;
  context: { profileId: string; sessionAgentId: string; cwd: string };
}): Promise<ProjectResourcesSnapshotResponse> {
  const resolution = await options.resolver.resolve(options.context);
  const dismissedPrompt = resolution.trust.key
    ? await options.settingsStore.getDismissedExecutablePrompt(resolution.trust.key)
    : undefined;

  return {
    generatedAt: new Date().toISOString(),
    profileId: resolution.profileId,
    sessionAgentId: resolution.sessionAgentId,
    cwdRealpath: resolution.cwdRealpath,
    ...(resolution.detectedGitRoot ? { detectedGitRoot: resolution.detectedGitRoot } : {}),
    ...(resolution.warning ? { warning: resolution.warning } : {}),
    ...(resolution.defaultForgeDir ? { defaultForgeDir: resolution.defaultForgeDir } : {}),
    ...(resolution.effectiveForgeDir ? { effectiveForgeDir: resolution.effectiveForgeDir } : {}),
    ...(resolution.effectiveForgeDirRealpath ? { effectiveForgeDirRealpath: resolution.effectiveForgeDirRealpath } : {}),
    source: resolution.source,
    ...(resolution.override ? { override: resolution.override } : {}),
    trust: resolution.trust,
    signature: resolution.signature,
    ...(dismissedPrompt ? { dismissedPrompt } : {}),
    scaffold: await buildScaffoldState(resolution),
    resources: await buildResourceInventory(resolution),
    executableSurfaces: await buildExecutableSurfaces(resolution)
  };
}

async function buildScaffoldState(resolution: ProjectWorkspaceResolution): Promise<ProjectResourcesSnapshotResponse["scaffold"]> {
  const targetDir = getSeedForgeDir(resolution);
  if (!targetDir) {
    return { canSeed: false, missing: [] };
  }

  const requiredEntries = [
    { label: ".forge/README.md", path: join(targetDir, "README.md"), kind: "file" as const },
    { label: ".forge/skills/", path: join(targetDir, "skills"), kind: "directory" as const },
    { label: ".forge/specialists/", path: join(targetDir, "specialists"), kind: "directory" as const },
    { label: ".forge/reference/", path: join(targetDir, "reference"), kind: "directory" as const },
    { label: ".forge/project-agents/", path: join(targetDir, "project-agents"), kind: "directory" as const },
    { label: ".forge/extensions/", path: join(targetDir, "extensions"), kind: "directory" as const },
    { label: ".forge/pi/extensions/", path: join(targetDir, "pi", "extensions"), kind: "directory" as const },
    { label: ".forge/pi/settings.json", path: join(targetDir, "pi", "settings.json"), kind: "file" as const }
  ];
  const missing: string[] = [];
  for (const entry of requiredEntries) {
    if (!(await scaffoldEntryExists(entry.path, entry.kind))) {
      missing.push(entry.label);
    }
  }
  return { targetDir, canSeed: true, missing };
}

async function scaffoldEntryExists(pathValue: string, kind: "directory" | "file"): Promise<boolean> {
  const entry = await stat(pathValue).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!entry) {
    return false;
  }
  return kind === "directory" ? entry.isDirectory() : entry.isFile();
}

async function buildResourceInventory(resolution: ProjectWorkspaceResolution): Promise<ProjectResourcesSnapshotResponse["resources"]> {
  const resources = resolution.repoRootResources;
  const projectAgentInventory = await scanRepoProjectAgentDefinitions(resources.projectAgentsDir);
  const projectAgents = {
    ...(projectAgentInventory.path ? { path: projectAgentInventory.path } : {}),
    exists: projectAgentInventory.exists,
    count: projectAgentInventory.count,
    items: projectAgentInventory.items,
    ...(projectAgentInventory.truncated ? { truncated: projectAgentInventory.truncated } : {}),
    ...(projectAgentInventory.problems ? { problems: projectAgentInventory.problems } : {})
  };
  return {
    skills: await listDirectoryEntries(resources.skillsDir, { directoryWithFile: "SKILL.md" }),
    specialists: await listDirectoryEntries(resources.specialistsDir, { extension: ".md" }),
    reference: await listDirectoryEntries(resources.referenceDir, { extension: ".md", recursive: true, skipSymlinks: true }),
    projectAgents,
    forgeExtensions: await listDirectoryEntries(resources.forgeExtensionsDir, { extension: [".ts", ".js"] }),
    piExtensions: await listDirectoryEntries(resources.piExtensionsDir, { extension: [".ts", ".js"] }),
    piSettings: await listSingleFile(resources.piSettingsPath)
  };
}

async function buildExecutableSurfaces(resolution: ProjectWorkspaceResolution): Promise<ProjectResourceExecutableSurface[]> {
  const surfaces: ProjectResourceExecutableSurface[] = [];
  if (resolution.repoRootResources.forgeExtensionsDir) {
    surfaces.push(await toExecutableSurface("repo-forge-extensions", resolution.repoRootResources.forgeExtensionsDir));
  }
  if (resolution.repoRootResources.piExtensionsDir) {
    surfaces.push(await toExecutableSurface("repo-pi-extensions", resolution.repoRootResources.piExtensionsDir));
  }
  if (resolution.repoRootResources.piSettingsPath) {
    surfaces.push(await toExecutableSurface("repo-pi-settings", resolution.repoRootResources.piSettingsPath));
  }

  for (const surface of resolution.legacyExecutableSurfaces) {
    surfaces.push({
      ...(await toExecutableSurface(surface.kind, surface.path)),
      activeToday: surface.activeToday,
      compatibilityPolicy: surface.compatibilityPolicy,
      ...(surface.coveredByTrustKey ? { coveredByTrustKey: surface.coveredByTrustKey } : {})
    });
  }
  return surfaces;
}

async function toExecutableSurface(kind: ProjectResourceExecutableSurface["kind"], path: string) {
  return { kind, path, exists: await pathExists(path) };
}

async function listSingleFile(path: string | undefined): Promise<ProjectResourceInventorySection> {
  if (!path) {
    return { exists: false, count: 0, items: [] };
  }
  return {
    path,
    exists: await pathExists(path),
    count: (await pathExists(path)) ? 1 : 0,
    items: (await pathExists(path)) ? [{ path, kind: "file" }] : []
  };
}

async function listDirectoryEntries(
  dirPath: string | undefined,
  options: { extension?: string | string[]; directoryWithFile?: string; recursive?: boolean; skipSymlinks?: boolean } = {}
): Promise<ProjectResourceInventorySection> {
  if (!dirPath) {
    return { path: dirPath, exists: false, count: 0, items: [] };
  }
  const rootStats = await lstat(dirPath).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    return { path: dirPath, exists: false, count: 0, items: [] };
  }

  const items: ProjectResourceInventorySection["items"] = [];
  const state = { truncated: false, entriesScanned: 0 };
  await collectEntries(dirPath, dirPath, options, items, state);
  items.sort((left, right) => left.path.localeCompare(right.path));
  return { path: dirPath, exists: true, count: items.length, items, ...(state.truncated ? { truncated: true } : {}) };
}

async function collectEntries(
  rootPath: string,
  currentPath: string,
  options: { extension?: string | string[]; directoryWithFile?: string; recursive?: boolean; skipSymlinks?: boolean },
  items: ProjectResourceInventorySection["items"],
  state: { truncated: boolean; entriesScanned: number }
): Promise<void> {
  if (items.length >= MAX_INVENTORY_ITEMS || state.entriesScanned >= MAX_INVENTORY_ENTRIES) {
    state.truncated = true;
    return;
  }
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  const extensions = Array.isArray(options.extension) ? options.extension : options.extension ? [options.extension] : [];
  for (const entry of entries) {
    if (items.length >= MAX_INVENTORY_ITEMS || state.entriesScanned >= MAX_INVENTORY_ENTRIES) {
      state.truncated = true;
      return;
    }
    state.entriesScanned += 1;
    if (state.entriesScanned >= MAX_INVENTORY_ENTRIES) {
      state.truncated = true;
      return;
    }
    const entryPath = join(currentPath, entry.name);
    if (entry.isSymbolicLink() && options.skipSymlinks) {
      continue;
    }
    if (entry.isDirectory()) {
      if (options.directoryWithFile && (await pathExists(join(entryPath, options.directoryWithFile)))) {
        items.push({ path: relativeOrSelf(rootPath, entryPath), kind: "directory" });
      }
      if (options.recursive) {
        await collectEntries(rootPath, entryPath, options, items, state);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (extensions.length > 0 && !extensions.includes(extname(entry.name).toLowerCase())) {
      continue;
    }
    items.push({ path: relativeOrSelf(rootPath, entryPath), kind: "file" });
  }
}

function relativeOrSelf(rootPath: string, path: string): string {
  return relative(rootPath, path) || ".";
}

function resolveContextFromQuery(swarmManager: SwarmManager, requestUrl: URL): { profileId: string; sessionAgentId: string; cwd: string } {
  const profileId = requestUrl.searchParams.get("profileId")?.trim() || undefined;
  const sessionAgentId = requestUrl.searchParams.get("sessionAgentId")?.trim() || undefined;
  return resolveContext(swarmManager, profileId, sessionAgentId);
}

function resolveContextFromBody(swarmManager: SwarmManager, body: unknown): { profileId: string; sessionAgentId: string; cwd: string } {
  if (!isRecord(body)) {
    throw new Error("Request body must be an object.");
  }
  return resolveContext(
    swarmManager,
    typeof body.profileId === "string" ? body.profileId : undefined,
    typeof body.sessionAgentId === "string" ? body.sessionAgentId : undefined
  );
}

function resolveContext(
  swarmManager: SwarmManager,
  rawProfileId: string | undefined,
  rawSessionAgentId: string | undefined
): { profileId: string; sessionAgentId: string; cwd: string } {
  const sessionAgentId = rawSessionAgentId?.trim();
  const profileId = rawProfileId?.trim();
  const descriptor = sessionAgentId ? swarmManager.getAgent(sessionAgentId) : findDefaultSession(swarmManager, profileId);
  if (!descriptor) {
    throw new Error(sessionAgentId ? `Unknown session: ${sessionAgentId}` : "No matching session found.");
  }
  if (descriptor.role !== "manager") {
    throw new Error("Project resources are resolved for manager sessions only.");
  }
  const resolvedProfileId = descriptor.profileId ?? descriptor.agentId;
  if (profileId && profileId !== resolvedProfileId) {
    throw new Error("Session does not belong to the requested profile.");
  }
  return { profileId: resolvedProfileId, sessionAgentId: descriptor.agentId, cwd: descriptor.cwd };
}

function findDefaultSession(swarmManager: SwarmManager, profileId: string | undefined): AgentDescriptor | undefined {
  return swarmManager
    .listAgents()
    .filter((descriptor) => descriptor.role === "manager")
    .find((descriptor) => !profileId || (descriptor.profileId ?? descriptor.agentId) === profileId);
}

function parseOverrideRequest(body: unknown): ProjectResourceOverrideRequest {
  if (!isRecord(body) || typeof body.profileId !== "string" || typeof body.sessionAgentId !== "string") {
    throw new Error("profileId and sessionAgentId are required.");
  }
  if (body.forgeDir !== null && typeof body.forgeDir !== "string") {
    throw new Error("forgeDir must be a string or null.");
  }
  return { profileId: body.profileId, sessionAgentId: body.sessionAgentId, forgeDir: body.forgeDir };
}

function parseTrustRequest(body: unknown): ProjectResourceTrustRequest {
  if (!isRecord(body) || typeof body.profileId !== "string" || typeof body.sessionAgentId !== "string") {
    throw new Error("profileId and sessionAgentId are required.");
  }
  if (body.action !== "trust" && body.action !== "block" && body.action !== "reset") {
    throw new Error("action must be trust, block, or reset.");
  }
  return { profileId: body.profileId, sessionAgentId: body.sessionAgentId, action: body.action };
}

function parseActivateRepoProjectAgentRequest(body: unknown): ActivateRepoProjectAgentRequest {
  if (!isRecord(body) || typeof body.profileId !== "string" || typeof body.sessionAgentId !== "string") {
    throw new Error("profileId and sessionAgentId are required.");
  }
  if (typeof body.definitionId !== "string" || body.definitionId.trim().length === 0) {
    throw new Error("definitionId is required.");
  }
  if (body.mode !== "create" && body.mode !== "link") {
    throw new Error("mode must be create or link.");
  }
  if (body.targetAgentId !== undefined && typeof body.targetAgentId !== "string") {
    throw new Error("targetAgentId must be a string when provided.");
  }
  if (body.applyRecommendedModel !== undefined && typeof body.applyRecommendedModel !== "boolean") {
    throw new Error("applyRecommendedModel must be a boolean when provided.");
  }
  if (body.explicitBindToSourceWorkspace !== undefined && typeof body.explicitBindToSourceWorkspace !== "boolean") {
    throw new Error("explicitBindToSourceWorkspace must be a boolean when provided.");
  }
  if (body.approvedCapabilities !== undefined && !Array.isArray(body.approvedCapabilities)) {
    throw new Error("approvedCapabilities must be an array when provided.");
  }
  return {
    profileId: body.profileId,
    sessionAgentId: body.sessionAgentId,
    definitionId: body.definitionId.trim(),
    mode: body.mode,
    ...(body.targetAgentId !== undefined ? { targetAgentId: body.targetAgentId } : {}),
    ...(body.applyRecommendedModel !== undefined ? { applyRecommendedModel: body.applyRecommendedModel } : {}),
    ...(body.approvedCapabilities !== undefined ? { approvedCapabilities: body.approvedCapabilities as ActivateRepoProjectAgentRequest["approvedCapabilities"] } : {}),
    ...(body.explicitBindToSourceWorkspace !== undefined ? { explicitBindToSourceWorkspace: body.explicitBindToSourceWorkspace } : {})
  };
}

function parseSeedRequest(body: unknown): ProjectResourceSeedRequest {
  if (!isRecord(body) || typeof body.profileId !== "string" || typeof body.sessionAgentId !== "string") {
    throw new Error("profileId and sessionAgentId are required.");
  }
  return { profileId: body.profileId, sessionAgentId: body.sessionAgentId };
}

async function seedProjectForgeScaffold(resolution: ProjectWorkspaceResolution): Promise<void> {
  const forgeDir = selectSeedForgeDir(resolution);
  await ensureDirectory(forgeDir);
  await Promise.all([
    ensureDirectory(join(forgeDir, "skills")),
    ensureDirectory(join(forgeDir, "specialists")),
    ensureDirectory(join(forgeDir, "reference")),
    ensureDirectory(join(forgeDir, "project-agents")),
    ensureDirectory(join(forgeDir, "extensions")),
    ensureDirectory(join(forgeDir, "pi")),
    ensureDirectory(join(forgeDir, "pi", "extensions"))
  ]);
  await writeFileIfMissing(join(forgeDir, "README.md"), PROJECT_FORGE_README);
  await writeFileIfMissing(join(forgeDir, "pi", "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
}

function selectSeedForgeDir(resolution: ProjectWorkspaceResolution): string {
  const forgeDir = getSeedForgeDir(resolution);
  if (forgeDir) {
    return forgeDir;
  }
  if (resolution.override && !resolution.override.valid) {
    throw new Error(resolution.override.error ?? "Configured .forge override directory is invalid.");
  }
  throw new Error("Cannot create project resources because no Git repository root was detected.");
}

function getSeedForgeDir(resolution: ProjectWorkspaceResolution): string | undefined {
  if (resolution.override?.valid) {
    return resolution.effectiveForgeDirRealpath;
  }
  if (!resolution.detectedGitRoot || !resolution.defaultForgeDir) {
    return undefined;
  }
  return resolution.effectiveForgeDirRealpath ?? resolution.defaultForgeDir;
}

async function ensureDirectory(pathValue: string): Promise<void> {
  const existing = await stat(pathValue).catch((error: unknown) => {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  });
  if (!existing) {
    await mkdir(pathValue, { recursive: true });
    return;
  }
  if (!existing.isDirectory()) {
    throw new Error(`${basename(pathValue)} exists but is not a directory.`);
  }
}

async function writeFileIfMissing(pathValue: string, content: string): Promise<void> {
  try {
    await writeFile(pathValue, content, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (isEexistError(error)) {
      return;
    }
    throw error;
  }
}

const PROJECT_FORGE_README = `# Forge project resources

This directory contains shared, agent-facing resources for this repository.

- \`skills/\`: project skills that agents can use as workflow instructions.
- \`specialists/\`: project-specific specialist definitions.
- \`reference/\`: passive markdown context and repository notes.
- \`project-agents/\`: passive repository-managed Project Agent definitions. Each definition uses \`config.json\`, a required \`prompt.md\`, and optional flat \`reference/*.md\` files.
- \`extensions/\`: Forge extensions. These are executable and require trust. If they rewrite shell commands, quote or escape injected output before it reaches \`bash\`; avoid building shell fragments such as \`; token ...\`.
- \`pi/extensions/\` and \`pi/settings.json\`: Pi extensions and package config. These are executable and require trust. List repo Pi extensions/custom tools explicitly in \`pi/settings.json\` so trust-gated loading stays deterministic.
- Keep executable smoke/test tools deterministic and harmless.

Keep secrets, credentials, build outputs, and runtime state out of this directory. Passive resources are readable as context; executable resources are loaded only after the repo-root \`.forge\` directory is trusted in Forge.
`;

function sendCorsJson(
  request: Parameters<typeof applyCorsHeaders>[0],
  response: Parameters<typeof sendJson>[0],
  statusCode: number,
  body: Record<string, unknown>
): void {
  applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
  sendJson(response, statusCode, body);
}

function createOverrideProbeStore(workspaceKey: string, forgeDir: string): ProjectResourceSettingsStore {
  const store = new ProjectResourceSettingsStore("/__forge_probe__");
  store.getOverride = async (key: string) => (key === workspaceKey ? { forgeDir, updatedAt: "" } : undefined);
  store.getTrust = async () => undefined;
  store.getDismissedExecutablePrompt = async () => undefined;
  return store;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isEexistError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

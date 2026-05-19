import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type {
  ProjectResourceExecutableSurface,
  ProjectResourceInventorySection,
  ProjectResourceMutationResponse,
  ProjectResourceOverrideRequest,
  ProjectResourcesSnapshotResponse,
  ProjectResourceTrustRequest
} from "@forge/protocol";
import { ProjectResourceSettingsStore } from "../../../swarm/project-resource-settings.js";
import { ProjectWorkspaceResolver, type ProjectWorkspaceResolution } from "../../../swarm/project-workspace-resolver.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import type { AgentDescriptor } from "../../../swarm/types.js";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const PROJECT_RESOURCES_ENDPOINT_PATH = "/api/settings/project-resources";
const PROJECT_RESOURCES_OVERRIDE_ENDPOINT_PATH = "/api/settings/project-resources/override";
const PROJECT_RESOURCES_TRUST_ENDPOINT_PATH = "/api/settings/project-resources/trust";
const PROJECT_RESOURCES_REFRESH_ENDPOINT_PATH = "/api/settings/project-resources/refresh";
const PROJECT_RESOURCES_METHODS = "GET, PUT, POST, OPTIONS";
const MAX_INVENTORY_ITEMS = 50;

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
        pathname === PROJECT_RESOURCES_REFRESH_ENDPOINT_PATH,
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

          if (pathname === PROJECT_RESOURCES_REFRESH_ENDPOINT_PATH && request.method === "POST") {
            const body = await readJsonBody(request);
            const context = resolveContextFromBody(swarmManager, body);
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
            if (forgeDir !== null) {
              const overrideCheck = await new ProjectWorkspaceResolver({ dataDir, settingsStore: createOverrideProbeStore(before.workspaceKey, forgeDir) }).resolve(context);
              if (!overrideCheck.override?.valid) {
                sendJson(response, 400, { error: overrideCheck.override?.error ?? "Invalid .forge override directory" });
                return;
              }
            }
            await settingsStore.setOverride(before.workspaceKey, forgeDir);
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
              sendJson(response, 400, { error: "No effective .forge directory is available for this workspace." });
              return;
            }
            await settingsStore.setTrust(resolution.trust.key, body.action);
            const snapshot = await buildSnapshot({ resolver, settingsStore, context });
            const payload: ProjectResourceMutationResponse = { success: true, snapshot };
            applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
            sendJson(response, 200, payload as unknown as Record<string, unknown>);
            return;
          }

          applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
          response.setHeader("Allow", PROJECT_RESOURCES_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
        } catch (error) {
          applyCorsHeaders(request, response, PROJECT_RESOURCES_METHODS);
          sendJson(response, 400, { error: error instanceof Error ? error.message : "Project resource request failed" });
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
    workspaceKey: resolution.workspaceKey,
    ...(resolution.defaultForgeDir ? { defaultForgeDir: resolution.defaultForgeDir } : {}),
    ...(resolution.effectiveForgeDir ? { effectiveForgeDir: resolution.effectiveForgeDir } : {}),
    ...(resolution.effectiveForgeDirRealpath ? { effectiveForgeDirRealpath: resolution.effectiveForgeDirRealpath } : {}),
    source: resolution.source,
    ...(resolution.override ? { override: resolution.override } : {}),
    trust: resolution.trust,
    signature: resolution.signature,
    ...(dismissedPrompt ? { dismissedPrompt } : {}),
    resources: await buildResourceInventory(resolution),
    executableSurfaces: await buildExecutableSurfaces(resolution)
  };
}

async function buildResourceInventory(resolution: ProjectWorkspaceResolution): Promise<ProjectResourcesSnapshotResponse["resources"]> {
  const resources = resolution.repoRootResources;
  return {
    skills: await listDirectoryEntries(resources.skillsDir, { directoryWithFile: "SKILL.md" }),
    specialists: await listDirectoryEntries(resources.specialistsDir, { extension: ".md" }),
    reference: await listDirectoryEntries(resources.referenceDir, { extension: ".md", recursive: true, skipSymlinks: true }),
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
  if (!dirPath || !(await pathExists(dirPath))) {
    return { path: dirPath, exists: false, count: 0, items: [] };
  }

  const items: ProjectResourceInventorySection["items"] = [];
  await collectEntries(dirPath, dirPath, options, items);
  items.sort((left, right) => left.path.localeCompare(right.path));
  return { path: dirPath, exists: true, count: items.length, items: items.slice(0, MAX_INVENTORY_ITEMS) };
}

async function collectEntries(
  rootPath: string,
  currentPath: string,
  options: { extension?: string | string[]; directoryWithFile?: string; recursive?: boolean; skipSymlinks?: boolean },
  items: ProjectResourceInventorySection["items"]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  const extensions = Array.isArray(options.extension) ? options.extension : options.extension ? [options.extension] : [];
  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name);
    if (entry.isSymbolicLink() && options.skipSymlinks) {
      continue;
    }
    if (entry.isDirectory()) {
      if (options.directoryWithFile && (await pathExists(join(entryPath, options.directoryWithFile)))) {
        items.push({ path: relativeOrSelf(rootPath, entryPath), kind: "directory" });
      }
      if (options.recursive) {
        await collectEntries(rootPath, entryPath, options, items);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

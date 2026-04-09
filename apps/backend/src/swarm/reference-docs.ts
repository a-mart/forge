import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VersioningMutationSink } from "../versioning/versioning-types.js";
import {
  getProfileKnowledgePath,
  getProfileReferencePath,
  getProjectAgentReferenceDir,
  sanitizePathSegment
} from "./data-paths.js";

export const PROFILE_REFERENCE_INDEX_FILE = "index.md";
export const LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE = "legacy-profile-knowledge.md";

export interface ProfileReferenceIndexLink {
  sectionTitle: string;
  label: string;
  fileName: string;
}

export interface ReferenceDocWriteOptions {
  versioning?: VersioningMutationSink;
}

export async function ensureProfileReferenceIndex(
  dataDir: string,
  profileId: string,
  options?: ReferenceDocWriteOptions
): Promise<{ path: string; created: boolean }> {
  return ensureProfileReferenceDoc(
    dataDir,
    profileId,
    PROFILE_REFERENCE_INDEX_FILE,
    buildProfileReferenceIndexTemplate(profileId),
    options
  );
}

export async function ensureProfileReferenceDoc(
  dataDir: string,
  profileId: string,
  fileName: string,
  initialContent?: string,
  options?: ReferenceDocWriteOptions
): Promise<{ path: string; created: boolean }> {
  const targetPath = getProfileReferencePath(dataDir, profileId, fileName);

  try {
    await readFile(targetPath, "utf8");
    return { path: targetPath, created: false };
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });

  if (fileName !== PROFILE_REFERENCE_INDEX_FILE) {
    await ensureProfileReferenceIndex(dataDir, profileId, options);
  }

  try {
    await writeFile(targetPath, initialContent ?? buildProfileReferenceDocTemplate(profileId, fileName), {
      encoding: "utf8",
      flag: "wx"
    });
    queueReferenceVersioningMutation(options?.versioning, {
      path: targetPath,
      action: "write",
      source: fileName === PROFILE_REFERENCE_INDEX_FILE ? "reference-index" : "reference-doc",
      profileId
    });
    return { path: targetPath, created: true };
  } catch (error) {
    if (isEexistError(error)) {
      return { path: targetPath, created: false };
    }

    throw error;
  }
}

export async function writeProfileReferenceDoc(
  dataDir: string,
  profileId: string,
  fileName: string,
  content: string,
  options?: { indexLink?: ProfileReferenceIndexLink; versioning?: VersioningMutationSink }
): Promise<{ path: string; created: boolean; updated: boolean }> {
  const ensured = await ensureProfileReferenceDoc(dataDir, profileId, fileName, content, options);
  const normalizedContent = ensureTrailingNewline(content.trimEnd());
  let updated = false;

  if (!ensured.created) {
    const existingContent = await readFile(ensured.path, "utf8");
    if (existingContent !== normalizedContent) {
      await writeFile(ensured.path, normalizedContent, "utf8");
      updated = true;
      queueReferenceVersioningMutation(options?.versioning, {
        path: ensured.path,
        action: "write",
        source: "reference-doc",
        profileId
      });
    }
  }

  if (options?.indexLink) {
    await ensureProfileReferenceIndexLink(dataDir, profileId, options.indexLink, options);
  }

  return {
    path: ensured.path,
    created: ensured.created,
    updated
  };
}

async function ensureProfileReferenceIndexLink(
  dataDir: string,
  profileId: string,
  link: ProfileReferenceIndexLink,
  options?: ReferenceDocWriteOptions
): Promise<{ path: string; updated: boolean }> {
  const index = await ensureProfileReferenceIndex(dataDir, profileId, options);
  const existing = await readFile(index.path, "utf8");
  const nextContent = buildReferenceIndexWithLink(existing, link);

  if (nextContent === existing) {
    return {
      path: index.path,
      updated: false
    };
  }

  await writeFile(index.path, nextContent, "utf8");
  queueReferenceVersioningMutation(options?.versioning, {
    path: index.path,
    action: "write",
    source: "reference-index",
    profileId
  });
  return {
    path: index.path,
    updated: true
  };
}

export async function migrateLegacyProfileKnowledgeToReferenceDoc(
  dataDir: string,
  profileId: string,
  options?: ReferenceDocWriteOptions
): Promise<
  | {
      sourcePath: string;
      path: string;
      created: boolean;
      updated: boolean;
    }
  | null
> {
  const sourcePath = getProfileKnowledgePath(dataDir, profileId);
  let legacyContent: string;

  try {
    legacyContent = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }

  if (legacyContent.trim().length === 0) {
    return null;
  }

  const migrated = await writeProfileReferenceDoc(
    dataDir,
    profileId,
    LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE,
    buildLegacyProfileKnowledgeReferenceDoc(profileId, legacyContent),
    {
      indexLink: {
        sectionTitle: "Migrated docs",
        label: "Legacy profile knowledge snapshot",
        fileName: LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE
      },
      versioning: options?.versioning
    }
  );

  queueReferenceVersioningMutation(options?.versioning, {
    path: sourcePath,
    action: "write",
    source: "legacy-knowledge-migration",
    profileId
  });

  return {
    sourcePath,
    path: migrated.path,
    created: migrated.created,
    updated: migrated.updated
  };
}

async function ensureProjectAgentReferenceDoc(
  dataDir: string,
  profileId: string,
  handle: string,
  fileName: string,
  initialContent = "",
  options?: ReferenceDocWriteOptions
): Promise<{ path: string; created: boolean }> {
  const targetPath = getProjectAgentReferencePath(dataDir, profileId, handle, fileName);

  try {
    await readFile(targetPath, "utf8");
    return { path: targetPath, created: false };
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });

  try {
    await writeFile(targetPath, ensureTrailingNewline(initialContent.trimEnd()), {
      encoding: "utf8",
      flag: "wx"
    });
    queueReferenceVersioningMutation(options?.versioning, {
      path: targetPath,
      action: "write",
      source: "reference-doc",
      profileId
    });
    return { path: targetPath, created: true };
  } catch (error) {
    if (isEexistError(error)) {
      return { path: targetPath, created: false };
    }

    throw error;
  }
}

export async function listProjectAgentReferenceDocs(
  dataDir: string,
  profileId: string,
  handle: string
): Promise<string[]> {
  const referenceDir = getProjectAgentReferenceDir(dataDir, profileId, handle);

  try {
    const entries = await readdir(referenceDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }
}

export async function readProjectAgentReferenceDoc(
  dataDir: string,
  profileId: string,
  handle: string,
  fileName: string
): Promise<string | null> {
  const targetPath = getProjectAgentReferencePath(dataDir, profileId, handle, fileName);

  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeProjectAgentReferenceDoc(
  dataDir: string,
  profileId: string,
  handle: string,
  fileName: string,
  content: string,
  options?: ReferenceDocWriteOptions
): Promise<{ path: string; created: boolean; updated: boolean }> {
  const ensured = await ensureProjectAgentReferenceDoc(dataDir, profileId, handle, fileName, content, options);
  const normalizedContent = ensureTrailingNewline(content.trimEnd());
  let updated = false;

  if (!ensured.created) {
    const existingContent = await readFile(ensured.path, "utf8");
    if (existingContent !== normalizedContent) {
      await writeFile(ensured.path, normalizedContent, "utf8");
      updated = true;
      queueReferenceVersioningMutation(options?.versioning, {
        path: ensured.path,
        action: "write",
        source: "reference-doc",
        profileId
      });
    }
  }

  return {
    path: ensured.path,
    created: ensured.created,
    updated
  };
}

export async function deleteProjectAgentReferenceDoc(
  dataDir: string,
  profileId: string,
  handle: string,
  fileName: string,
  options?: ReferenceDocWriteOptions
): Promise<void> {
  const targetPath = getProjectAgentReferencePath(dataDir, profileId, handle, fileName);

  try {
    await rm(targetPath, { force: false });
    queueReferenceVersioningMutation(options?.versioning, {
      path: targetPath,
      action: "delete",
      source: "reference-doc",
      profileId
    });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }
}

export function buildProfileReferenceIndexTemplate(profileId: string): string {
  return [
    `# ${profileId} Reference Index`,
    "",
    "> Pull-based profile reference docs maintained by Cortex.",
    "> These docs are read on demand and are not auto-injected into runtime prompts.",
    "",
    "## Core docs",
    "- [Overview](./overview.md)",
    "- [Architecture](./architecture.md)",
    "- [Conventions](./conventions.md)",
    "- [Gotchas](./gotchas.md)",
    "- [Decisions](./decisions.md)",
    "",
    "## Topic docs",
    "- Add focused topic-specific docs here as needed.",
    ""
  ].join("\n");
}

function buildLegacyProfileKnowledgeReferenceDoc(profileId: string, legacyContent: string): string {
  const normalizedLegacyContent = legacyContent.trimEnd();

  return [
    `# ${profileId} Legacy Profile Knowledge`,
    "",
    "> Migrated from `shared/knowledge/profiles/<profileId>.md` during the Cortex Memory v2 rollout.",
    "> Preserve as reference while Cortex reclassifies long-form project knowledge into injected summary memory vs. pull-based docs.",
    "",
    "## Legacy snapshot",
    "",
    normalizedLegacyContent,
    ""
  ].join("\n");
}

function getProjectAgentReferencePath(
  dataDir: string,
  profileId: string,
  handle: string,
  fileName: string
): string {
  return join(getProjectAgentReferenceDir(dataDir, profileId, handle), sanitizePathSegment(fileName));
}

function queueReferenceVersioningMutation(
  versioning: VersioningMutationSink | undefined,
  mutation: { path: string; action: "write" | "delete"; source: "reference-doc" | "reference-index" | "legacy-knowledge-migration"; profileId: string }
): void {
  void versioning?.recordMutation(mutation).catch(() => {
    // Fail open: reference doc writes succeed even when versioning cannot record them.
  });
}

function buildProfileReferenceDocTemplate(profileId: string, fileName: string): string {
  const baseName = fileName.replace(/\.md$/i, "");
  const title = baseName
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");

  return [`# ${profileId} ${title}`, "", "> Maintained by Cortex.", ""].join("\n");
}

function buildReferenceIndexWithLink(existingContent: string, link: ProfileReferenceIndexLink): string {
  const normalizedExisting = ensureTrailingNewline(existingContent.trimEnd());
  const sectionHeading = `## ${link.sectionTitle}`;
  const linkLine = `- [${link.label}](./${link.fileName})`;

  if (normalizedExisting.includes(linkLine)) {
    return normalizedExisting;
  }

  const lines = normalizedExisting.split("\n");
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeading);

  if (sectionIndex === -1) {
    return `${normalizedExisting.trimEnd()}\n\n${sectionHeading}\n${linkLine}\n`;
  }

  let insertIndex = sectionIndex + 1;
  while (insertIndex < lines.length) {
    const currentLine = lines[insertIndex]?.trim() ?? "";
    if (currentLine.startsWith("## ")) {
      break;
    }
    insertIndex += 1;
  }

  const nextLines = [...lines];
  nextLines.splice(insertIndex, 0, linkLine);
  return ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isEexistError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

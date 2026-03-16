import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getProfileKnowledgePath, getProfileReferencePath } from "./data-paths.js";

export const PROFILE_REFERENCE_INDEX_FILE = "index.md";
export const LEGACY_PROFILE_KNOWLEDGE_REFERENCE_FILE = "legacy-profile-knowledge.md";

export interface ProfileReferenceIndexLink {
  sectionTitle: string;
  label: string;
  fileName: string;
}

export async function ensureProfileReferenceIndex(
  dataDir: string,
  profileId: string
): Promise<{ path: string; created: boolean }> {
  return ensureProfileReferenceDoc(dataDir, profileId, PROFILE_REFERENCE_INDEX_FILE, buildProfileReferenceIndexTemplate(profileId));
}

export async function ensureProfileReferenceDoc(
  dataDir: string,
  profileId: string,
  fileName: string,
  initialContent?: string
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
    await ensureProfileReferenceIndex(dataDir, profileId);
  }

  try {
    await writeFile(targetPath, initialContent ?? buildProfileReferenceDocTemplate(profileId, fileName), {
      encoding: "utf8",
      flag: "wx"
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
  options?: { indexLink?: ProfileReferenceIndexLink }
): Promise<{ path: string; created: boolean; updated: boolean }> {
  const ensured = await ensureProfileReferenceDoc(dataDir, profileId, fileName, content);
  const normalizedContent = ensureTrailingNewline(content.trimEnd());
  let updated = false;

  if (!ensured.created) {
    const existingContent = await readFile(ensured.path, "utf8");
    if (existingContent !== normalizedContent) {
      await writeFile(ensured.path, normalizedContent, "utf8");
      updated = true;
    }
  }

  if (options?.indexLink) {
    await ensureProfileReferenceIndexLink(dataDir, profileId, options.indexLink);
  }

  return {
    path: ensured.path,
    created: ensured.created,
    updated
  };
}

export async function ensureProfileReferenceIndexLink(
  dataDir: string,
  profileId: string,
  link: ProfileReferenceIndexLink
): Promise<{ path: string; updated: boolean }> {
  const index = await ensureProfileReferenceIndex(dataDir, profileId);
  const existing = await readFile(index.path, "utf8");
  const nextContent = buildReferenceIndexWithLink(existing, link);

  if (nextContent === existing) {
    return {
      path: index.path,
      updated: false
    };
  }

  await writeFile(index.path, nextContent, "utf8");
  return {
    path: index.path,
    updated: true
  };
}

export async function migrateLegacyProfileKnowledgeToReferenceDoc(
  dataDir: string,
  profileId: string
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
      }
    }
  );

  return {
    sourcePath,
    path: migrated.path,
    created: migrated.created,
    updated: migrated.updated
  };
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

export function buildLegacyProfileKnowledgeReferenceDoc(profileId: string, legacyContent: string): string {
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

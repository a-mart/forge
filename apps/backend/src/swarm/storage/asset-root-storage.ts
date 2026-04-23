import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizePathSegment } from "./data-paths.js";

export interface ReferenceDocMetadata {
  fileName: string;
  path: string;
}

export async function readPromptFile(promptPath: string): Promise<string | null> {
  try {
    return await readFile(promptPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writePromptFile(promptPath: string, content: string): Promise<void> {
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, content, "utf8");
}

export async function listReferenceDocs(referenceDir: string): Promise<ReferenceDocMetadata[]> {
  try {
    const entries = await readdir(referenceDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        fileName: entry.name,
        path: join(referenceDir, entry.name)
      }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }
}

export async function readReferenceDoc(referenceDir: string, filename: string): Promise<string | null> {
  const targetPath = getReferenceDocPath(referenceDir, filename);

  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeReferenceDoc(referenceDir: string, filename: string, content: string): Promise<void> {
  const targetPath = getReferenceDocPath(referenceDir, filename);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, ensureTrailingNewline(content.trimEnd()), "utf8");
}

export async function deleteReferenceDoc(referenceDir: string, filename: string): Promise<void> {
  const targetPath = getReferenceDocPath(referenceDir, filename);

  try {
    await rm(targetPath, { force: false });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }

    throw error;
  }
}

function getReferenceDocPath(referenceDir: string, filename: string): string {
  return join(referenceDir, sanitizePathSegment(filename));
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

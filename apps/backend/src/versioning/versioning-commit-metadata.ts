import type { GitCommitMetadata, PromptCategory } from "@forge/protocol";

const PATH_PREFIX = /^-\s+/u;
const PROMPT_CATEGORIES = new Set<PromptCategory>(["archetype", "operational"]);

export function parseVersioningCommitMetadata(body: string): GitCommitMetadata | null {
  if (typeof body !== "string" || body.trim().length === 0) {
    return null;
  }

  const metadata: GitCommitMetadata = { paths: [] };
  let recognizedFields = 0;
  const lines = body.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed) {
      continue;
    }

    if (trimmed === "Paths:") {
      recognizedFields += 1;
      for (let pathIndex = index + 1; pathIndex < lines.length; pathIndex += 1) {
        const rawPathLine = lines[pathIndex] ?? "";
        const pathLine = rawPathLine.trim();
        if (!pathLine) {
          continue;
        }

        if (!PATH_PREFIX.test(pathLine)) {
          break;
        }

        const path = pathLine.replace(PATH_PREFIX, "").trim();
        if (path) {
          metadata.paths.push(path);
        }

        index = pathIndex;
      }
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    switch (key) {
      case "Reason":
        if (value) {
          metadata.reason = value;
          recognizedFields += 1;
        }
        break;
      case "Source":
        if (value) {
          metadata.source = value;
          metadata.sources = [value];
          recognizedFields += 1;
        }
        break;
      case "Sources": {
        const sources = value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (sources.length > 0) {
          metadata.sources = sources;
          if (sources.length === 1) {
            metadata.source = sources[0];
          }
          recognizedFields += 1;
        }
        break;
      }
      case "Profile":
        if (value) {
          metadata.profileId = value;
          recognizedFields += 1;
        }
        break;
      case "Session":
        if (value) {
          metadata.sessionId = value;
          recognizedFields += 1;
        }
        break;
      case "Agent":
        if (value) {
          metadata.agentId = value;
          recognizedFields += 1;
        }
        break;
      case "Prompt": {
        const prompt = parsePromptReference(value);
        if (prompt) {
          metadata.promptCategory = prompt.promptCategory;
          metadata.promptId = prompt.promptId;
          recognizedFields += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  if (recognizedFields === 0) {
    return null;
  }

  metadata.paths = Array.from(new Set(metadata.paths));
  return metadata;
}

function parsePromptReference(value: string): { promptCategory: PromptCategory; promptId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  const promptCategory = trimmed.slice(0, slashIndex).trim() as PromptCategory;
  const promptId = trimmed.slice(slashIndex + 1).trim();

  if (!PROMPT_CATEGORIES.has(promptCategory) || !promptId) {
    return null;
  }

  return {
    promptCategory,
    promptId
  };
}

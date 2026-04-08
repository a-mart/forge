import type {
  PromptCategory,
  PromptPreviewResponse,
  PromptPreviewSection,
  PromptSourceLayer,
} from "@forge/protocol";

export type { PromptPreviewResponse, PromptPreviewSection } from "@forge/protocol";

export interface PromptEntry {
  category: PromptCategory;
  promptId: string;
  content: string;
  sourceLayer: PromptSourceLayer;
  sourcePath: string;
}

export interface PromptRegistryReader {
  resolve(
    category: PromptCategory,
    promptId: string,
    profileId?: string,
  ): Promise<string>;

  resolveEntry(
    category: PromptCategory,
    promptId: string,
    profileId?: string,
  ): Promise<PromptEntry | undefined>;

  resolveAtLayer(
    category: PromptCategory,
    promptId: string,
    layer: PromptSourceLayer,
    profileId?: string,
  ): Promise<string | undefined>;

  listAll(profileId?: string): Promise<PromptEntry[]>;
}

export interface PromptRegistryWriter {
  save(
    category: PromptCategory,
    promptId: string,
    content: string,
    profileId: string,
  ): Promise<void>;

  deleteOverride(
    category: PromptCategory,
    promptId: string,
    profileId: string,
  ): Promise<void>;

  hasOverride(
    category: PromptCategory,
    promptId: string,
    profileId: string,
  ): Promise<boolean>;
}

export interface PromptRegistryContract extends PromptRegistryReader, PromptRegistryWriter {}

export type PromptRegistryForRoutes = PromptRegistryContract;

export interface PromptPreviewProvider {
  previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse>;
}

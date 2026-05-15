import type { SkillSourceKind } from "@forge/protocol";

export const SKILL_BUNDLE_FORMAT = "forge.skill.bundle.v1" as const;
export const SKILL_BUNDLE_VERSION = 1 as const;
export const SKILL_BUNDLE_SKILL_FILE_NAME = "SKILL.md";
export const DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const DEFAULT_SKILL_BUNDLE_MAX_FILES = 512;

export const SHAREABLE_SKILL_SOURCE_KINDS: ReadonlySet<SkillSourceKind> = new Set(["machine-local", "profile"]);

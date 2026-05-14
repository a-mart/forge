export type SkillBundleErrorCode =
  | "unknown_skill"
  | "unshareable_skill_source"
  | "invalid_skill_handle"
  | "invalid_skill_path"
  | "invalid_skill_root"
  | "unsupported_symlink"
  | "sensitive_file"
  | "oversized_file"
  | "oversized_bundle"
  | "too_many_files"
  | "missing_skill_file"
  | "invalid_skill_file"
  | "invalid_skill_bundle";

export class SkillBundleError extends Error {
  readonly code: SkillBundleErrorCode;
  readonly path?: string;

  constructor(code: SkillBundleErrorCode, message: string, options: { path?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SkillBundleError";
    this.code = code;
    this.path = options.path;
  }
}

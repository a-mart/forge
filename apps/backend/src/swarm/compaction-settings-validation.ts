export class CompactionSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionSettingsValidationError";
  }
}

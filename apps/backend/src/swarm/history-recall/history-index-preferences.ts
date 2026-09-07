import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { getHistoryIndexSettingsPath } from "../storage/data-paths.js";

/** User intent lives outside the disposable index. Mutations use the service's queue. */
export class HistoryIndexPreferences {
  paused = false;
  error: string | null = null;
  private loading?: Promise<void>;
  constructor(private readonly dataDir: string) {}

  load(): Promise<void> {
    return this.loading ??= this.read();
  }

  private async read(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(getHistoryIndexSettingsPath(this.dataDir), "utf8"));
      if (!data || typeof data !== "object" || typeof (data as { paused?: unknown }).paused !== "boolean") throw new Error("Invalid preference");
      this.paused = (data as { paused: boolean }).paused;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.paused = true;
      this.error = "Saved indexing preferences could not be read. Indexing is paused; resume to save a new preference.";
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.load();
    await writeJsonFileAtomic(getHistoryIndexSettingsPath(this.dataDir), { paused }, { mode: 0o600 });
    this.paused = paused;
    this.error = null;
  }
}

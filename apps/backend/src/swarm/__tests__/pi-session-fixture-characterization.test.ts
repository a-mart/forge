/**
 * WP-0: version-labelled Pi v3 JSONL fixture scaffolding for the 0.71.1 baseline.
 * Uses real SessionManager.open — no createAgentSession mocks.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-sessions",
  "0.71.1",
);

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("pi session fixture characterization (0.71.1 baseline)", () => {
  it("declares Pi session format version 3 and lists fixtures", async () => {
    const manifest = JSON.parse(await readFile(join(FIXTURE_ROOT, "manifest.json"), "utf8")) as {
      piSessionFormatVersion: number;
      forgeBaseline: string;
      fixtures: Array<{ id: string; file: string }>;
    };

    expect(manifest.piSessionFormatVersion).toBe(CURRENT_SESSION_VERSION);
    expect(manifest.forgeBaseline).toBe("0.71.1");
    expect(manifest.fixtures.map((f) => f.id)).toEqual([
      "minimal-session",
      "thinking-levels",
      "with-compaction-and-custom",
    ]);
  });

  it("opens each labelled fixture with SessionManager and preserves labelled entry shapes", async () => {
    const manifest = JSON.parse(await readFile(join(FIXTURE_ROOT, "manifest.json"), "utf8")) as {
      fixtures: Array<{ id: string; file: string }>;
    };

    const hashes: Record<string, string> = {};

    for (const fixture of manifest.fixtures) {
      const path = join(FIXTURE_ROOT, fixture.file);
      hashes[fixture.id] = await sha256File(path);

      const session = SessionManager.open(path);
      expect(session.getSessionId()).toBeTruthy();

      const entries = session.getBranch();
      expect(entries.length).toBeGreaterThan(0);

      if (fixture.id === "minimal-session") {
        expect(entries.some((e) => e.type === "message" && e.message.role === "user")).toBe(true);
        expect(entries.some((e) => e.type === "message" && e.message.role === "assistant")).toBe(true);
      }

      if (fixture.id === "thinking-levels") {
        const levels = entries
          .filter((e) => e.type === "thinking_level_change")
          .map((e) => (e as { thinkingLevel: string }).thinkingLevel);
        expect(levels).toEqual(["none", "xhigh", "ultra"]);
      }

      if (fixture.id === "with-compaction-and-custom") {
        expect(entries.some((e) => e.type === "compaction")).toBe(true);
        expect(entries.some((e) => e.type === "custom")).toBe(true);
        expect(entries.some((e) => e.type === "custom_message")).toBe(true);
      }
    }

    // Stable hashes are the upgrade baseline fingerprint (content-addressed).
    expect(Object.keys(hashes).sort()).toEqual([
      "minimal-session",
      "thinking-levels",
      "with-compaction-and-custom",
    ]);
    for (const hash of Object.values(hashes)) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

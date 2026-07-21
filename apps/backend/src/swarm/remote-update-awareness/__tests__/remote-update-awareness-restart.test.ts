import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runRemoteUpdateAwarenessMigrations } from "../remote-update-awareness-migrations.js";
import { RemoteUpdateAwarenessStore } from "../remote-update-awareness-store.js";
import { createTestStore, OID_A, OID_B, target } from "./test-helpers.js";

describe("remote update awareness restart persistence", () => {
  it("preserves settings, association, generation, observations, and dismissal", async () => {
    const created = await createTestStore();
    created.store.setGlobalEnabled(true);
    created.store.setProjectOverride("project-a", "on");
    created.store.recordObservation("project-a", target(), { state: "remote_ahead", tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z" });
    created.store.recordObservation("project-a", target(), { state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T01:00:00.000Z" });
    created.store.dismissExact({ projectId: "project-a", monitorKey: "monitor-a", ref: "refs/heads/trunk", tipOid: OID_B, generation: 2 });
    created.database.close();

    const reopened = new Database(created.path);
    runRemoteUpdateAwarenessMigrations(reopened);
    const store = new RemoteUpdateAwarenessStore(reopened);
    expect(store.getSettings().globalEnabled).toBe(true);
    expect(store.getProjectSnapshot("project-a")).toMatchObject({
      override: "on", monitorKey: "monitor-a", ref: "refs/heads/trunk",
      tipOid: OID_B, generation: 2, dismissed: true, hasUndismissedUpdate: false
    });
    reopened.close();
  });
});

import { describe, expect, it } from "vitest";
import { createTestStore, OID_A, OID_B, target } from "./test-helpers.js";

describe("RemoteUpdateAwarenessStore", () => {
  it("persists opt-in settings and tri-state project overrides", async () => {
    const { database, store } = await createTestStore();
    expect(store.getSettings().globalEnabled).toBe(false);
    expect(store.getProjectSnapshot("project-a").override).toBe("inherit");
    expect(store.getProjectSnapshot("project-a").effectiveEnabled).toBe(false);

    store.setProjectOverride("project-a", "on");
    store.setGlobalEnabled(true);
    expect(store.getProjectSnapshot("project-a").effectiveEnabled).toBe(true);
    store.setProjectOverride("project-a", "off");
    expect(store.getProjectSnapshot("project-a").effectiveEnabled).toBe(false);
    expect(store.getProjectSnapshot("project-a", false).effectiveEnabled).toBe(false);
    database.close();
  });

  it("records a silent baseline, equal polls, changed generations, and exact dismissal", async () => {
    const { database, store } = await createTestStore();
    store.setGlobalEnabled(true);
    const resolved = target();

    const baseline = store.recordObservation("project-a", resolved, {
      state: "remote_ahead", tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(baseline).toMatchObject({ baseline: true, changed: false, generation: 1 });
    expect(baseline.snapshot.hasUndismissedUpdate).toBe(false);

    const equal = store.recordObservation("project-a", resolved, {
      state: "remote_ahead", tipOid: OID_A, observedAt: "2026-01-01T00:15:00.000Z"
    });
    expect(equal).toMatchObject({ baseline: false, changed: false, generation: 1 });

    const changed = store.recordObservation("project-a", resolved, {
      state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T00:30:00.000Z"
    });
    expect(changed).toMatchObject({ changed: true, generation: 2 });
    expect(changed.snapshot.hasUndismissedUpdate).toBe(true);

    expect(store.dismissExact({
      projectId: "project-a", monitorKey: resolved.monitorKey, ref: resolved.targetRef,
      tipOid: OID_A, generation: 2
    })).toBe(false);
    expect(store.dismissExact({
      projectId: "project-a", monitorKey: resolved.monitorKey, ref: resolved.targetRef,
      tipOid: OID_B, generation: 2
    })).toBe(true);
    expect(store.getProjectSnapshot("project-a")).toMatchObject({ dismissed: true, hasUndismissedUpdate: false });

    store.recordObservation("project-a", resolved, {
      state: "rewound", tipOid: OID_A, observedAt: "2026-01-01T00:45:00.000Z"
    });
    expect(store.getProjectSnapshot("project-a")).toMatchObject({ generation: 3, dismissed: false, hasUndismissedUpdate: true });
    store.recordMonitorFailure(resolved, "missing", "2026-01-01T01:00:00.000Z");
    expect(store.getMonitor(resolved.monitorKey)).toMatchObject({ latestState: "missing", latestTipOid: OID_A });
    expect(store.getProjectSnapshot("project-a")).toMatchObject({ generation: 4, state: "missing", hasUndismissedUpdate: false });
    database.close();
  });

  it("never accepts a delayed dismissal token after target reassociation", async () => {
    const { database, store } = await createTestStore();
    store.setGlobalEnabled(true);
    const firstTarget = target();
    store.recordObservation("project-a", firstTarget, {
      state: "remote_ahead", tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z"
    });
    store.recordObservation("project-a", firstTarget, {
      state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T00:15:00.000Z"
    });
    const delayedGeneration = store.getProjectSnapshot("project-a").generation;

    const secondTarget = target({
      monitorKey: "monitor-b",
      remoteFingerprint: "fingerprint-b",
      targetRef: "refs/heads/main",
      destinationRef: "refs/remotes/upstream/main",
    });
    store.recordObservation("project-a", secondTarget, {
      state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T00:30:00.000Z"
    });
    expect(store.getProjectSnapshot("project-a").generation).toBeGreaterThan(delayedGeneration);
    expect(store.dismissExact({
      projectId: "project-a",
      monitorKey: secondTarget.monitorKey,
      ref: secondTarget.targetRef,
      tipOid: OID_B,
      generation: delayedGeneration,
    })).toBe(false);
    expect(store.getDismissal("project-a")).toBeNull();
    database.close();
  });

  it("shares monitor observations while preserving project settings and dismissal", async () => {
    const { database, store } = await createTestStore();
    store.setGlobalEnabled(true);
    const resolved = target();
    store.associateProject("project-a", resolved);
    store.associateProject("project-b", resolved);
    store.setProjectOverride("project-b", "off");
    store.recordObservation(
      "project-a", resolved,
      { state: "remote_ahead", tipOid: OID_A, observedAt: "2026-01-01T00:00:00.000Z" },
      ["project-a"]
    );
    store.recordObservation(
      "project-a", resolved,
      { state: "remote_ahead", tipOid: OID_B, observedAt: "2026-01-01T00:15:00.000Z" },
      ["project-a"]
    );

    expect(store.getProjectSnapshot("project-a")).toMatchObject({ generation: 2, hasUndismissedUpdate: true });
    expect(store.getProjectSnapshot("project-b")).toMatchObject({
      override: "off", generation: 1, tipOid: null, hasUndismissedUpdate: false
    });
    store.recordMonitorFailure(resolved, "timeout", undefined, ["project-a"]);
    expect(store.getProject("project-a")?.failureCount).toBe(1);
    expect(store.getProject("project-b")).toMatchObject({ failureCount: 0, lastState: null });

    store.associateProject("project-a", target({ monitorKey: "monitor-new", remoteFingerprint: "fingerprint-new" }));
    expect(store.getProjectSnapshot("project-a")).toMatchObject({ generation: 4, tipOid: null, dismissed: false });
    expect(store.getProjectSnapshot("project-b")).toMatchObject({ monitorKey: "monitor-a", generation: 1 });
    database.close();
  });
});

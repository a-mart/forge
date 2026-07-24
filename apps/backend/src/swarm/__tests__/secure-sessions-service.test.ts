import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor, SecureSessionSnapshotEvent } from "@forge/protocol";
import type {
  SecureExecutionBackend,
  SecureExecutionRequest,
  SecureExecutionTask,
} from "../secure-sessions/execution/secure-execution-backend.js";
import { SECURE_OUTPUT_QUARANTINE } from "../secure-sessions/redaction/secure-value-guard.js";
import { SecureSessionsService } from "../secure-sessions/secure-sessions-service.js";
import type { SecureVaultCipher } from "../secure-sessions/sources/electron-safe-storage-client.js";
import {
  HostOnlySecret,
  SecureSourceError,
  type SecureSecretSource,
} from "../secure-sessions/sources/host-only-secret.js";
import { runSecureSessionMigrations } from "../secure-sessions/storage/secure-session-migrations.js";
import { SecureSessionStore } from "../secure-sessions/storage/secure-session-store.js";

const NOW = "2026-07-23T12:00:00.000Z";
const ALPHA = "alpha-secret-3f4d2c";
const BETA = "beta-secret-8e7a1b";

describe("SecureSessionsService", () => {
  it("creates a stable automatic delivery for secrets saved without bindings", async () => {
    const harness = createHarness();
    const created = await harness.service.createLocalSecureSecret({
      displayAlias: "server/password",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });

    expect(created.bindings).toEqual([expect.objectContaining({
      deliveryKind: "environment",
      targetName: expect.stringMatching(/^FORGE_SECRET_SERVER_PASSWORD_[A-Z0-9]+$/),
    })]);
    const originalBinding = created.bindings[0];

    const renamed = await harness.service.updateSecureSecret(created.secretId, {
      displayAlias: "renamed/password",
    });
    expect(renamed.bindings).toEqual([originalBinding]);
    await harness.close();
  });

  it("backfills a default delivery for legacy secrets that have no bindings", async () => {
    const harness = createHarness();
    const created = await harness.service.createLocalSecureSecret({
      displayAlias: "legacy/password",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
    });
    const [existingBinding] = harness.store.listBindings(created.secretId);
    expect(existingBinding).toBeDefined();
    harness.store.deleteBinding(existingBinding!.bindingId);
    expect(harness.store.listBindings(created.secretId)).toEqual([]);

    await harness.service.initializeSecureSessions();

    const backfilledBindings = harness.store.listBindings(created.secretId);
    expect(backfilledBindings).toEqual([
      expect.objectContaining({
        deliveryKind: "environment",
        targetName: expect.stringMatching(/^FORGE_SECRET_LEGACY_PASSWORD_[A-Z0-9]+$/),
      }),
    ]);
    await harness.service.initializeSecureSessions();
    expect(harness.store.listBindings(created.secretId)).toEqual(backfilledBindings);
    await harness.close();
  });

  it("recovers every stale sandbox once before authorizing secure execution", async () => {
    const harness = createHarness({ recoveredSandboxIds: ["stale-a", "stale-b"] });

    await expect(harness.service.initializeSecureSessions()).resolves.toEqual({
      destroyedSandboxIds: ["stale-a", "stale-b"],
    });
    await harness.service.startSecureSession("manager-a");
    await harness.service.startSecureSession("manager-b");

    expect(harness.execution.recoveryCalls).toEqual([[]]);
    expect(harness.execution.ensured).toEqual(["manager-a", "manager-b"]);
    await harness.close();
  });

  it("keeps secure execution fail-closed until startup recovery can succeed", async () => {
    const harness = createHarness({ recoveryFailures: 1 });

    await expect(
      harness.service.startSecureSession("manager-a"),
    ).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.execution.ensured).toEqual([]);
    expect(harness.execution.recoveryCalls).toHaveLength(1);

    await expect(harness.service.startSecureSession("manager-a")).resolves.toEqual(
      expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "ready",
      }),
    );
    expect(harness.execution.recoveryCalls).toHaveLength(2);
    expect(harness.execution.ensured).toEqual(["manager-a"]);
    await harness.close();
  });

  it("blocks lifecycle deletion until persisted orphan recovery succeeds", async () => {
    const harness = createHarness({ recoveryFailures: 1 });
    harness.store.getOrCreateSessionState("manager-a", {
      profileId: "profile-a",
      executionMode: "secure",
      environmentStatus: "ready",
    });

    await expect(harness.service.stopSecureSessionForLifecycle(
      "manager-a",
      { deleteState: true },
    )).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(true);

    await expect(harness.service.stopSecureSessionForLifecycle(
      "manager-a",
      { deleteState: true },
    )).resolves.toBeUndefined();
    expect(harness.store.listSessionStates().some(
      (state) => state.sessionAgentId === "manager-a",
    )).toBe(false);
    expect(harness.execution.recoveryCalls).toHaveLength(2);
    await harness.close();
  });

  it("continues shutdown cleanup after one task destroy fails", async () => {
    const harness = createHarness({ destroyFailures: ["manager-a"] });
    await harness.service.startSecureSession("manager-a");
    await harness.service.startSecureSession("manager-b");

    await expect(harness.service.closeSecureSessions()).resolves.toBeUndefined();
    expect(harness.execution.destroyed).toEqual(
      expect.arrayContaining(["manager-a", "manager-b"]),
    );
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-b")!,
    )).toBeUndefined();
  });

  it("drains an admitted start before taking the final shutdown task snapshot", async () => {
    const harness = createHarness({ blockEnsures: ["manager-a"] });
    const starting = harness.service.startSecureSession("manager-a");
    await harness.execution.waitForBlockedEnsure("manager-a");

    const closing = harness.service.closeSecureSessions();
    await Promise.resolve();
    expect(harness.execution.destroyed).not.toContain("manager-a");

    harness.execution.releaseBlockedEnsure("manager-a");
    await expect(starting).resolves.toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    await expect(closing).resolves.toBeUndefined();
    expect(harness.execution.destroyed).toContain("manager-a");
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();
  });

  it("keeps explicit stop authoritative over an in-flight execution failure", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await vi.waitFor(() => {
      expect(harness.execution.hasBlockedExecution("manager-a")).toBe(true);
    });
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    const stopping = harness.service.stopSecureSession("manager-a", {
      baseRevision: snapshot.revision,
      stopProcesses: true,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(stopping).resolves.toEqual(expect.objectContaining({
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      executionMode: "standard",
      environmentStatus: "stopped",
    }));
    await harness.close();
  });

  it("keeps revoke authoritative over an in-flight execution failure", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await vi.waitFor(() => {
      expect(harness.execution.hasBlockedExecution("manager-a")).toBe(true);
    });
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    const revoking = harness.service.revokeSecureSessionLease("manager-a", {
      baseRevision: snapshot.revision,
      leaseId: snapshot.leases[0]!.leaseId,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(revoking).resolves.toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "stopped",
      leases: [expect.objectContaining({ status: "revoked" })],
    }));
    await harness.close();
  });

  it("does not revoke an active lease while recording a provider health check", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const before = await harness.service.getSecureSessionSnapshot("manager-a");
    const destroysBefore = harness.execution.destroyed.length;

    await expect(
      harness.service.testSecureSecretProvider("forge-local-keychain"),
    ).resolves.toEqual(expect.objectContaining({
      providerId: "forge-local-keychain",
      status: "available",
    }));

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.leases).toEqual([
      expect.objectContaining({
        leaseId: before.leases[0]!.leaseId,
        status: "active",
      }),
    ]);
    expect(after.environmentStatus).toBe("ready");
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    await harness.close();
  });

  it("records a provider resolution failure without invalidating another session", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 1 });
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "shared",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "shared");
    harness.execution.destroyed.length = 0;

    await expect(
      grant(harness, "manager-b", secret.secretId, "shared"),
    ).rejects.toThrow("SECURE_SOURCE_UNAVAILABLE");

    const unaffected = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(unaffected.environmentStatus).toBe("ready");
    expect(unaffected.leases).toEqual([
      expect.objectContaining({ secretId: secret.secretId, status: "active" }),
    ]);
    expect(harness.execution.destroyed).not.toContain("manager-a");
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    await harness.close();
  });

  it("serializes provider testing with deletion so status cannot resurrect a provider", async () => {
    const harness = createHarness({ blockProviderStatus: true });
    await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });

    const testing = harness.service.testSecureSecretProvider(
      "forge-local-keychain",
    );
    await harness.waitForBlockedProviderStatus();
    let deletionSettled = false;
    const deleting = harness.service.deleteSecureSecretProvider(
      "forge-local-keychain",
    ).finally(() => {
      deletionSettled = true;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);

    harness.releaseBlockedProviderStatus();
    await expect(testing).resolves.toEqual(expect.objectContaining({
      status: "available",
    }));
    await expect(deleting).resolves.toBeUndefined();
    expect(
      (await harness.service.listSecureSecretProviders())
        .some((provider) => provider.providerId === "forge-local-keychain"),
    ).toBe(false);
    await harness.close();
  });

  it("preserves unrelated leases when intentional revocation tears down an in-flight task", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    await grant(harness, "manager-a", alpha.secretId, "alpha");
    const first = await harness.service.getSecureSessionSnapshot("manager-a");
    const withBeta = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: first.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    const alphaLease = withBeta.leases.find((lease) => lease.secretId === alpha.secretId)!;
    const betaLease = withBeta.leases.find((lease) => lease.secretId === beta.secretId)!;
    harness.execution.destroyed.length = 0;
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");

    const revoking = harness.service.revokeSecureSessionLease("manager-a", {
      baseRevision: withBeta.revision,
      leaseId: alphaLease.leaseId,
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");
    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(revoking).resolves.toEqual(expect.objectContaining({
      environmentStatus: "stopped",
    }));

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after.leases.find((lease) => lease.leaseId === alphaLease.leaseId)?.status)
      .toBe("revoked");
    expect(after.leases.find((lease) => lease.leaseId === betaLease.leaseId)?.status)
      .toBe("active");
    await harness.close();
  });

  it("keeps lease caches and guards session-scoped across repeated execution and stop", async () => {
    const harness = createHarness();
    const alphaSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const betaSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });

    await grant(harness, "manager-a", alphaSecret.secretId, "alpha");
    await grant(harness, "manager-b", betaSecret.secretId, "beta");
    const alphaBinding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const betaBinding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-b")!)!;

    for (let index = 0; index < 16; index += 1) {
      const output: string[] = [];
      await alphaBinding.executeBash({
        command: "safe-alpha",
        cwd: "/workspace-a",
        onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
      });
      expect(output.join("")).toBe("safe");
    }
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);

    const crossSessionOutput: string[] = [];
    await betaBinding.executeBash({
      command: "emit-alpha-canary",
      cwd: "/workspace-b",
      onData: (bytes) => crossSessionOutput.push(Buffer.from(bytes).toString("utf8")),
    });
    expect(crossSessionOutput.join("")).toBe(ALPHA);
    expect(harness.sourceResolutions.get(BETA)).toBe(1);

    const alphaSnapshot = await harness.service.getSecureSessionSnapshot("manager-a");
    await harness.service.stopSecureSession("manager-a", {
      baseRevision: alphaSnapshot.revision,
      stopProcesses: true,
    });
    await betaBinding.executeBash({
      command: "safe-beta",
      cwd: "/workspace-b",
      onData: () => undefined,
    });
    expect(harness.sourceResolutions.get(BETA)).toBe(1);
    await harness.close();
  });

  it("serializes concurrent grants so one stale revision cannot create a second lease", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const request = {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment" as const, targetName: "ALPHA_TOKEN" }],
      leaseKind: "task" as const,
    };

    const results = await Promise.allSettled([
      harness.service.grantSecureSessionLease("manager-a", request),
      harness.service.grantSecureSessionLease("manager-a", request),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      leases: [expect.objectContaining({ status: "active" })],
    }));
    await harness.close();
  });

  it("grants several proactive secrets with one rebuild, revision, and final snapshot", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{
        deliveryKind: "file",
        targetPath: "/run/forge-secure/bindings/beta",
        fileMode: 0o400,
      }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const snapshotsBefore = harness.snapshots.length;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;

    const result = await harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: started.revision,
      grants: [
        {
          secretId: alpha.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: beta.secretId,
          exposures: [{
            deliveryKind: "file",
            targetPath: "/run/forge-secure/bindings/beta",
            fileMode: 0o400,
          }],
          leaseKind: "timed",
          durationSeconds: 300,
        },
      ],
    });

    expect(result.revision).toBe(started.revision + 1);
    expect(result.leases).toEqual([
      expect.objectContaining({ secretId: alpha.secretId, status: "active" }),
      expect.objectContaining({ secretId: beta.secretId, status: "active" }),
    ]);
    expect(harness.execution.destroyed).toHaveLength(destroysBefore + 1);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore + 1);
    expect(harness.snapshots).toHaveLength(snapshotsBefore + 1);
    const stored = harness.store.getSnapshot("manager-a");
    expect(new Set(stored.leases.map(({ issuedRevision }) => issuedRevision)))
      .toEqual(new Set([result.revision]));
    expect(harness.store.listAudit("manager-a").filter(({ eventType }) =>
      eventType === "lease_created"
    )).toHaveLength(2);
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);
    expect(harness.sourceResolutions.get(BETA)).toBe(1);
    expect(harness.resolvedMaterials).toHaveLength(2);
    expect(harness.resolvedMaterials.every(({ released }) => !released)).toBe(true);
    await harness.close();
  });

  it("rejects cross-batch binding collisions before rebuilding or creating any lease", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const snapshotsBefore = harness.snapshots.length;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;
    const auditsBefore = harness.store.listAudit("manager-a").length;

    await expect(harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: started.revision,
      grants: [
        {
          secretId: alpha.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: beta.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
          leaseKind: "one_use",
        },
      ],
    })).rejects.toThrow("SECURE_REQUEST_INVALID");

    expect(harness.store.getSnapshot("manager-a")).toEqual(expect.objectContaining({
      state: expect.objectContaining({ revision: started.revision }),
      leases: [],
    }));
    expect(harness.store.listAudit("manager-a")).toHaveLength(auditsBefore);
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(harness.snapshots).toHaveLength(snapshotsBefore);
    await harness.close();
  });

  it("releases a pre-resolved batch on source failure without disturbing existing authority", async () => {
    const harness = createHarness({ failSourceResolutionAfter: 2 });
    const existing = await harness.service.createLocalSecureSecret({
      displayAlias: "existing",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "EXISTING_TOKEN" }],
    });
    const proposed = await harness.service.createLocalSecureSecret({
      displayAlias: "proposed",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "PROPOSED_TOKEN" }],
    });
    const failing = await harness.service.createLocalSecureSecret({
      displayAlias: "failing",
      encryptedMaterial: Buffer.from("failing-secret").toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "FAILING_TOKEN" }],
    });
    await grant(harness, "manager-a", existing.secretId, "existing");
    const before = await harness.service.getSecureSessionSnapshot("manager-a");
    const existingMaterial = harness.resolvedMaterials[0]!;
    const destroysBefore = harness.execution.destroyed.length;
    const ensuresBefore = harness.execution.ensured.length;
    const leaseAuditsBefore = harness.store.listAudit("manager-a").filter(
      ({ eventType }) => eventType === "lease_created",
    ).length;

    await expect(harness.service.grantSecureSessionLeases("manager-a", {
      baseRevision: before.revision,
      grants: [
        {
          secretId: proposed.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "PROPOSED_TOKEN" }],
          leaseKind: "task",
        },
        {
          secretId: failing.secretId,
          exposures: [{ deliveryKind: "environment", targetName: "FAILING_TOKEN" }],
          leaseKind: "task",
        },
      ],
    })).rejects.toThrow("SECURE_SOURCE_UNAVAILABLE");

    const after = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(after).toEqual(expect.objectContaining({
      revision: before.revision,
      environmentStatus: "ready",
      leases: [expect.objectContaining({
        leaseId: before.leases[0]!.leaseId,
        secretId: existing.secretId,
        status: "active",
      })],
    }));
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(harness.store.listAudit("manager-a").filter(
      ({ eventType }) => eventType === "lease_created",
    )).toHaveLength(leaseAuditsBefore);
    expect(existingMaterial.released).toBe(false);
    expect(harness.resolvedMaterials[1]?.released).toBe(true);

    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await expect(binding.executeBash({
      command: "safe-existing",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });
    expect(harness.sourceResolutions.get(ALPHA)).toBe(1);
    await harness.close();
  });

  it("makes secret rotation authoritative over an admitted execution", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      command: "wait-for-destroy",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");
    harness.execution.destroyed.length = 0;

    const rotating = harness.service.updateSecureSecret(secret.secretId, {
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.rejectBlockedExecution("manager-a");

    await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
    await expect(rotating).resolves.toEqual(expect.objectContaining({
      secretId: secret.secretId,
    }));
    expect(
      await harness.service.getSecureSessionSnapshot("manager-a"),
    ).toEqual(expect.objectContaining({
      environmentStatus: "stopped",
    }));
    await harness.close();
  });

  it("runs ordinary secure Bash with zero leases and zeroizes delivery copies", async () => {
    const harness = createHarness();
    await expect(harness.service.getSecureSessionAgentView("manager-a")).resolves.toEqual(
      expect.objectContaining({ executionMode: "standard", leases: [] }),
    );
    await harness.service.startSecureSession("manager-a");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];
    await binding.executeBash({
      command: "safe-zero-lease",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    });
    expect(output.join("")).toBe("safe");

    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    await binding.executeBash({
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(harness.execution.lastDeliveryValue).toBeDefined();
    expect([...harness.execution.lastDeliveryValue!]).toEqual(
      new Array(harness.execution.lastDeliveryValue!.byteLength).fill(0),
    );
    await harness.close();
  });

  it("guards non-Bash tool values before first use and fails closed on a stale one-use binding", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "ALPHA_TOKEN",
      }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    expect(binding.guardValue(ALPHA)).toBe(SECURE_OUTPUT_QUARANTINE);
    await binding.executeBash({
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    expect(() => binding.guardValue("workspace file contents")).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    expect(harness.recycles).toContain("manager-a");
    await harness.close();
  });

  it("rebuilds a previously active environment before a new secret can be exposed", async () => {
    const harness = createHarness();
    await harness.service.startSecureSession("manager-a");
    const retainedBinding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const before = await harness.service.getSecureSessionSnapshot("manager-a");

    const granted = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: before.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "task",
    });

    expect(harness.execution.destroyed).toContain("manager-a");
    expect(harness.execution.ensured).toEqual(["manager-a", "manager-a"]);
    expect(granted.environmentStatus).toBe("ready");
    expect(retainedBinding.guardValue(ALPHA)).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    await harness.service.stopSecureSession("manager-a", {
      baseRevision: granted.revision,
      stopProcesses: true,
    });
    expect(() => retainedBinding.guardValue("after stop")).toThrow(
      "SECURE_OPERATION_FAILED",
    );
    await harness.close();
  });

  it("does not reprovision over an environment whose teardown was unconfirmed", async () => {
    const harness = createHarness();
    const first = await harness.service.createLocalSecureSecret({
      displayAlias: "first",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const second = await harness.service.createLocalSecureSecret({
      displayAlias: "second",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    await grant(harness, "manager-a", first.secretId, "alpha");
    harness.execution.destroyUnconfirmed.add("manager-a");
    const ensuresBefore = harness.execution.ensured.length;
    const snapshot = await harness.service.getSecureSessionSnapshot("manager-a");

    await expect(
      harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: snapshot.revision,
        secretId: second.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
        leaseKind: "task",
      }),
    ).rejects.toMatchObject({
      code: "SECURE_OPERATION_FAILED",
    });

    expect(harness.execution.ensured).toHaveLength(ensuresBefore);
    expect(
      (await harness.service.getSecureSessionSnapshot("manager-a"))
        .environmentStatus,
    ).toBe("degraded");
    await harness.close();
  });

  it("rejects reserved and cross-kind guest environment name collisions before execution", async () => {
    const harness = createHarness();
    await expect(
      harness.service.createLocalSecureSecret({
        displayAlias: "reserved",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "PATH" }],
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    await expect(
      harness.service.createLocalSecureSecret({
        displayAlias: "collision",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [
          { deliveryKind: "environment", targetName: "FORGE_TOKEN" },
          { deliveryKind: "askpass", targetName: "FORGE_TOKEN" },
        ],
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });

    const environmentSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "environment",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "SHARED_TOKEN" }],
    });
    const askpassSecret = await harness.service.createLocalSecureSecret({
      displayAlias: "askpass",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "askpass", targetName: "SHARED_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const first = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: environmentSecret.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "SHARED_TOKEN",
      }],
      leaseKind: "task",
    });
    const destroysBefore = harness.execution.destroyed.length;
    await expect(
      harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: first.revision,
        secretId: askpassSecret.secretId,
        exposures: [{
          deliveryKind: "askpass",
          targetName: "SHARED_TOKEN",
        }],
        leaseKind: "task",
      }),
    ).rejects.toMatchObject({ code: "SECURE_REQUEST_INVALID" });
    expect(harness.execution.destroyed).toHaveLength(destroysBefore);
    await harness.close();
  });

  it("destroys the process environment when a lease is revoked or consumed", async () => {
    const revoked = createHarness();
    const taskSecret = await revoked.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(revoked, "manager-a", taskSecret.secretId, "alpha");
    const taskSnapshot = await revoked.service.getSecureSessionSnapshot("manager-a");
    const afterRevoke = await revoked.service.revokeSecureSessionLease("manager-a", {
      baseRevision: taskSnapshot.revision,
      leaseId: taskSnapshot.leases[0]!.leaseId,
    });
    expect(afterRevoke.environmentStatus).toBe("stopped");
    expect(revoked.execution.destroyed).toContain("manager-a");
    expect(revoked.service.getSecureRuntimeBinding(
      revoked.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await revoked.close();

    const consumed = createHarness();
    const oneUseSecret = await consumed.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await consumed.service.startSecureSession("manager-a");
    await consumed.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: oneUseSecret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = consumed.service.getSecureRuntimeBinding(
      consumed.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    const consumedSnapshot = await consumed.service.getSecureSessionSnapshot("manager-a");
    expect(consumedSnapshot.environmentStatus).toBe("stopped");
    expect(consumedSnapshot.leases[0]?.status).toBe("consumed");
    expect(consumed.execution.destroyed).toContain("manager-a");
    expect(consumed.service.getSecureRuntimeBinding(
      consumed.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await consumed.close();
  });

  it("serializes parallel Bash calls across one-use consumption and teardown", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;

    const first = binding.executeBash({
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");
    const second = binding.executeBash({
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await Promise.resolve();
    expect(harness.execution.executed).toEqual(["manager-a"]);

    harness.execution.releaseBlockedExecution("manager-a");
    await expect(first).resolves.toEqual({ exitCode: 0 });
    await expect(second).rejects.toThrow("SECURE_OPERATION_FAILED");
    expect(harness.execution.executed).toEqual(["manager-a"]);
    expect(harness.execution.destroyed).toContain("manager-a");
    await harness.close();
  });

  it("does not republish a closed environment when one-use completion races a grant", async () => {
    const harness = createHarness();
    const alpha = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const beta = await harness.service.createLocalSecureSecret({
      displayAlias: "beta",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    const oneUse = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: alpha.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    const execution = binding.executeBash({
      command: "wait-for-release",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    await harness.execution.waitForBlockedExecution("manager-a");

    const granting = harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: oneUse.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    await vi.waitFor(() => {
      expect(harness.execution.destroyed).toContain("manager-a");
    });
    harness.execution.releaseBlockedExecution("manager-a");

    await expect(execution).resolves.toEqual({ exitCode: 0 });
    await expect(granting).rejects.toThrow("SECURE_STALE_REVISION");
    const afterRace = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(afterRace.environmentStatus).toBe("stopped");
    expect(afterRace.leases.some((lease) =>
      lease.secretId === beta.secretId && lease.status === "active"
    )).toBe(false);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeUndefined();

    const retried = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: afterRace.revision,
      secretId: beta.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "task",
    });
    expect(retried.environmentStatus).toBe("ready");
    expect(retried.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ secretId: beta.secretId, status: "active" }),
    ]));
    await harness.close();
  });

  it("does not tear down an active environment for a secret with only historical leases", async () => {
    const harness = createHarness();
    const historical = await harness.service.createLocalSecureSecret({
      displayAlias: "historical",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "HISTORICAL_TOKEN" }],
    });
    const current = await harness.service.createLocalSecureSecret({
      displayAlias: "current",
      encryptedMaterial: Buffer.from(BETA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "CURRENT_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: historical.secretId,
      exposures: [{
        deliveryKind: "environment",
        targetName: "HISTORICAL_TOKEN",
      }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )!;
    await binding.executeBash({
      command: "safe-alpha",
      cwd: "/workspace-a",
      onData: () => undefined,
    });
    const consumed = await harness.service.getSecureSessionSnapshot("manager-a");
    const active = await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: consumed.revision,
      secretId: current.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "CURRENT_TOKEN" }],
      leaseKind: "task",
    });
    harness.execution.destroyed.length = 0;

    await harness.service.updateSecureSecret(historical.secretId, {
      displayName: "Historical credential",
    });

    const afterUpdate = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(afterUpdate.environmentStatus).toBe("ready");
    expect(afterUpdate.leases.find((lease) =>
      lease.secretId === current.secretId
    )).toEqual(expect.objectContaining({ status: "active" }));
    expect(afterUpdate.revision).toBe(active.revision);
    expect(harness.execution.destroyed).toEqual([]);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    await harness.close();
  });

  it("expires timed leases with a real process reaper", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
        leaseKind: "timed",
        durationSeconds: 1,
      });

      logicalNow += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      const expired = await harness.service.getSecureSessionSnapshot("manager-a");
      expect(expired.leases[0]?.status).toBe("expired");
      expect(expired.environmentStatus).toBe("stopped");
      expect(harness.execution.destroyed).toContain("manager-a");
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects execution and tears down when logical expiry wins before the timer runs", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
        leaseKind: "timed",
        durationSeconds: 1,
      });
      const binding = harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("manager-a")!,
      )!;
      const executionsBeforeExpiry = harness.execution.executed.length;

      logicalNow += 1_001;
      await expect(binding.executeBash({
        command: "safe-alpha",
        cwd: "/workspace-a",
        onData: () => undefined,
      })).rejects.toThrow("SECURE_OPERATION_FAILED");

      expect(harness.execution.executed).toHaveLength(executionsBeforeExpiry);
      expect(harness.execution.destroyed).toContain("manager-a");
      expect(
        await harness.service.getSecureSessionSnapshot("manager-a"),
      ).toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "stopped",
        leases: [expect.objectContaining({ status: "expired" })],
      }));
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed expiry authoritative over an in-flight execution failure", async () => {
    vi.useFakeTimers();
    try {
      let logicalNow = Date.parse(NOW);
      const harness = createHarness({
        now: () => new Date(logicalNow).toISOString(),
      });
      const secret = await harness.service.createLocalSecureSecret({
        displayAlias: "alpha",
        encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
        bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      });
      const started = await harness.service.startSecureSession("manager-a");
      await harness.service.grantSecureSessionLease("manager-a", {
        baseRevision: started.revision,
        secretId: secret.secretId,
        exposures: [{
          deliveryKind: "environment",
          targetName: "ALPHA_TOKEN",
        }],
        leaseKind: "timed",
        durationSeconds: 1,
      });
      const binding = harness.service.getSecureRuntimeBinding(
        harness.descriptors.get("manager-a")!,
      )!;
      const execution = binding.executeBash({
        command: "wait-for-destroy",
        cwd: "/workspace-a",
        onData: () => undefined,
      });
      await harness.execution.waitForBlockedExecution("manager-a");

      logicalNow += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.execution.destroyed).toContain("manager-a");
      harness.execution.rejectBlockedExecution("manager-a");
      await expect(execution).rejects.toThrow("SECURE_OPERATION_FAILED");
      for (let index = 0; index < 10; index += 1) await Promise.resolve();

      expect(
        await harness.service.getSecureSessionSnapshot("manager-a"),
      ).toEqual(expect.objectContaining({
        executionMode: "secure",
        environmentStatus: "stopped",
        leases: [expect.objectContaining({ status: "expired" })],
      }));
      await harness.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts secure execution before approving a request made in standard mode", async () => {
    const harness = createHarness();
    await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await harness.service.requestSecureSecretAccess("manager-a", "tool-1", {
      displayAlias: "alpha",
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "task",
      purposeSummary: "Use the configured test credential",
    });
    const pending = await harness.service.getSecureSessionSnapshot("manager-a");
    expect(pending.executionMode).toBe("standard");
    const requestId = pending.pendingRequests[0]!.requestId;
    const approved = await harness.service.resolveSecureAccessRequest(
      "manager-a",
      requestId,
      {
        baseRevision: pending.revision,
        requestId,
        decision: "approve",
      },
    );
    expect(approved).toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    expect(approved.leases).toHaveLength(1);
    expect(harness.service.getSecureRuntimeBinding(
      harness.descriptors.get("manager-a")!,
    )).toBeDefined();
    expect(harness.recycles).toEqual(["manager-a"]);

    await harness.service.requestSecureSecretAccess("manager-b", "tool-2", {
      displayAlias: "private-beta",
      exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
      leaseKind: "one_use",
      purposeSummary: "Use a private one-time credential",
    });
    const privatePending = await harness.service.getSecureSessionSnapshot("manager-b");
    const privateRequestId = privatePending.pendingRequests[0]!.requestId;
    const fulfilled = await harness.service.fulfillSecureAccessRequest(
      "manager-b",
      privateRequestId,
      {
        baseRevision: privatePending.revision,
        displayAlias: "private-beta",
        encryptedMaterial: Buffer.from(BETA).toString("base64"),
        exposures: [{ deliveryKind: "environment", targetName: "BETA_TOKEN" }],
        leaseKind: "one_use",
      },
    );
    expect(fulfilled).toEqual(expect.objectContaining({
      executionMode: "secure",
      environmentStatus: "ready",
    }));
    expect(fulfilled.leases).toHaveLength(1);
    expect(harness.recycles).toEqual(["manager-a", "manager-b"]);
    await harness.close();
  });

  it("reconciles ghost-ready persisted state and rolls back a recycle failure", async () => {
    const ghost = createHarness();
    ghost.store.getOrCreateSessionState("manager-a", {
      profileId: "profile-a",
      executionMode: "secure",
      environmentStatus: "ready",
    });
    const reconciled = await ghost.service.getSecureSessionSnapshot("manager-a");
    expect(reconciled.environmentStatus).toBe("failed");
    expect(ghost.execution.destroyed).toContain("manager-a");
    await ghost.close();

    const failedRecycle = createHarness({ recycleThrows: true });
    await expect(
      failedRecycle.service.startSecureSession("manager-a"),
    ).rejects.toThrow("SECURE_OPERATION_FAILED");
    const failed = await failedRecycle.service.getSecureSessionSnapshot("manager-a");
    expect(failed.environmentStatus).toBe("failed");
    expect(failedRecycle.service.getSecureRuntimeBinding(
      failedRecycle.descriptors.get("manager-a")!,
    )).toBeUndefined();
    await failedRecycle.close();
  });

  it("redacts protected output, preserves task leases, and emits only fixed state metadata", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];
    const destroyedBeforeReflection = harness.execution.destroyed.length;
    await expect(binding.executeBash({
      command: "emit-own-canary",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });

    expect(output.join("")).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(harness.execution.destroyed).toHaveLength(destroyedBeforeReflection);
    const safeOutput: string[] = [];
    await expect(binding.executeBash({
      command: "emit-safe-output",
      cwd: "/workspace-a",
      onData: (bytes) => safeOutput.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });
    expect(safeOutput.join("")).toBe("safe");
    const eventJson = JSON.stringify(harness.snapshots);
    expect(eventJson).not.toContain(ALPHA);
    expect(harness.snapshots.at(-1)).toEqual(expect.objectContaining({
      environmentStatus: "ready",
      outputState: "quarantined",
      outputStateCode: "SECURE_OUTPUT_QUARANTINED",
      leases: [expect.objectContaining({ status: "active" })],
    }));
    await harness.close();
  });

  it("does not treat the public redaction marker as proof that a secret matched", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    await grant(harness, "manager-a", secret.secretId, "alpha");
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;
    const output: string[] = [];

    await expect(binding.executeBash({
      command: "emit-public-marker",
      cwd: "/workspace-a",
      onData: (bytes) => output.push(Buffer.from(bytes).toString("utf8")),
    })).resolves.toEqual({ exitCode: 0 });

    expect(output.join("")).toBe(SECURE_OUTPUT_QUARANTINE);
    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "ready",
        outputState: "clear",
      }),
    );
    await harness.close();
  });

  it("consumes a one-use lease after redacting the credentialed command output", async () => {
    const harness = createHarness();
    const secret = await harness.service.createLocalSecureSecret({
      displayAlias: "alpha",
      encryptedMaterial: Buffer.from(ALPHA).toString("base64"),
      bindings: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
    });
    const started = await harness.service.startSecureSession("manager-a");
    await harness.service.grantSecureSessionLease("manager-a", {
      baseRevision: started.revision,
      secretId: secret.secretId,
      exposures: [{ deliveryKind: "environment", targetName: "ALPHA_TOKEN" }],
      leaseKind: "one_use",
    });
    const binding = harness.service.getSecureRuntimeBinding(harness.descriptors.get("manager-a")!)!;

    await expect(binding.executeBash({
      command: "emit-own-canary",
      cwd: "/workspace-a",
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });

    expect(await harness.service.getSecureSessionSnapshot("manager-a")).toEqual(
      expect.objectContaining({
        environmentStatus: "stopped",
        outputState: "quarantined",
        leases: [expect.objectContaining({
          status: "consumed",
          remainingUses: 0,
        })],
      }),
    );
    await harness.close();
  });
});

async function grant(
  harness: ReturnType<typeof createHarness>,
  managerId: string,
  secretId: string,
  alias: string,
): Promise<void> {
  const snapshot = await harness.service.startSecureSession(managerId);
  await harness.service.grantSecureSessionLease(managerId, {
    baseRevision: snapshot.revision,
    secretId,
    exposures: [{
      deliveryKind: "environment",
      targetName: `${alias.toUpperCase()}_TOKEN`,
    }],
    leaseKind: "task",
  });
}

function createHarness(options: {
  blockProviderStatus?: boolean;
  blockEnsures?: readonly string[];
  destroyFailures?: readonly string[];
  failSourceResolutionAfter?: number;
  now?: () => string;
  recoveredSandboxIds?: readonly string[];
  recoveryFailures?: number;
  recycleThrows?: boolean;
} = {}) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  runSecureSessionMigrations(database);
  const now = options.now ?? (() => NOW);
  const store = new SecureSessionStore(database, undefined, () => new Date(now()));
  const descriptors = new Map<string, AgentDescriptor>([
    ["manager-a", descriptor("manager-a", "profile-a", "/workspace-a")],
    ["manager-b", descriptor("manager-b", "profile-b", "/workspace-b")],
  ]);
  const execution = new FakeExecutionBackend(options);
  const sourceResolutions = new Map<string, number>();
  const resolvedMaterials: HostOnlySecret[] = [];
  const localSource: SecureSecretSource & {
    testConnection(): Promise<void>;
  } = {
    kind: "local_keychain",
    async testConnection() {},
    async resolve(input) {
      const bytes = Buffer.from(input.encryptedMaterial ?? []);
      const key = bytes.toString("utf8");
      const resolutionCount = [...sourceResolutions.values()]
        .reduce((total, value) => total + value, 0);
      if (
        options.failSourceResolutionAfter !== undefined
        && resolutionCount >= options.failSourceResolutionAfter
      ) {
        bytes.fill(0);
        throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
      }
      sourceResolutions.set(key, (sourceResolutions.get(key) ?? 0) + 1);
      const material = new HostOnlySecret(bytes);
      resolvedMaterials.push(material);
      return {
        material,
        sourceVersion: null,
        resolvedAt: NOW,
      };
    },
  };
  const snapshots: SecureSessionSnapshotEvent[] = [];
  const recycles: string[] = [];
  let nextId = 0;
  let providerStatusStarted!: () => void;
  let providerStatusRelease!: () => void;
  const providerStatusStartedPromise = new Promise<void>((resolve) => {
    providerStatusStarted = resolve;
  });
  const providerStatusReleasePromise = new Promise<void>((resolve) => {
    providerStatusRelease = resolve;
  });
  const cipher: SecureVaultCipher & { dispose(): void } = {
    async status() {
      if (options.blockProviderStatus) {
        providerStatusStarted();
        await providerStatusReleasePromise;
      }
      return { available: true };
    },
    async encrypt(bytes) { return Buffer.from(bytes); },
    async decrypt(bytes) { return new HostOnlySecret(bytes); },
    dispose() {},
  };
  const service = new SecureSessionsService({
    storeFactory: async () => store,
    cipher,
    localSource,
    bitwardenSource: localSource,
    probeBitwarden: async () => true,
    execution,
    getDescriptor: (agentId) => descriptors.get(agentId),
    requireBuilderSession: (agentId) => {
      const value = descriptors.get(agentId);
      if (!value) throw new Error("missing");
      return value;
    },
    emitSnapshot: (event) => snapshots.push(event),
    emitCatalogChanged: () => undefined,
    applyModeRuntimeRecycle: async (agentId) => {
      recycles.push(agentId);
      if (options.recycleThrows) throw new Error("recycle failed");
    },
    now,
    createId: () => `id-${++nextId}`,
  });
  return {
    service,
    store,
    descriptors,
    execution,
    sourceResolutions,
    resolvedMaterials,
    snapshots,
    recycles,
    async waitForBlockedProviderStatus() {
      await providerStatusStartedPromise;
    },
    releaseBlockedProviderStatus() {
      providerStatusRelease();
    },
    async close() {
      await service.closeSecureSessions();
    },
  };
}

class FakeExecutionBackend implements SecureExecutionBackend {
  readonly kind = "fake";
  readonly destroyed: string[] = [];
  readonly ensured: string[] = [];
  readonly executed: string[] = [];
  readonly recoveryCalls: SecureExecutionTask[][] = [];
  readonly destroyUnconfirmed = new Set<string>();
  private readonly blockedExecutions = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly blockedExecutionWaiters = new Map<
    string,
    Set<() => void>
  >();
  private readonly blockedEnsures = new Map<string, () => void>();
  private readonly blockedEnsureWaiters = new Map<string, Set<() => void>>();
  private recoveryFailures: number;
  lastDeliveryValue: Uint8Array | undefined;

  constructor(private readonly options: {
    destroyFailures?: readonly string[];
    recoveredSandboxIds?: readonly string[];
    recoveryFailures?: number;
    blockEnsures?: readonly string[];
  } = {}) {
    this.recoveryFailures = options.recoveryFailures ?? 0;
  }

  async probe() {
    return { available: true, code: "available" as const };
  }

  async ensureTask(task: SecureExecutionTask) {
    this.ensured.push(task.taskId);
    if (this.options.blockEnsures?.includes(task.taskId)) {
      await new Promise<void>((resolve) => {
        this.blockedEnsures.set(task.taskId, resolve);
        const waiters = this.blockedEnsureWaiters.get(task.taskId);
        this.blockedEnsureWaiters.delete(task.taskId);
        for (const waiter of waiters ?? []) waiter();
      });
    }
    return { backend: this.kind, sandboxId: task.taskId };
  }

  async waitForBlockedEnsure(taskId: string): Promise<void> {
    if (this.blockedEnsures.has(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedEnsureWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedEnsureWaiters.set(taskId, waiters);
    });
  }

  releaseBlockedEnsure(taskId: string): void {
    const release = this.blockedEnsures.get(taskId);
    this.blockedEnsures.delete(taskId);
    release?.();
  }

  async execute(request: SecureExecutionRequest) {
    this.executed.push(request.task.taskId);
    this.lastDeliveryValue = request.delivery?.environment?.[0]?.value;
    const command = request.command.args.at(-1);
    if (command === "wait-for-destroy" || command === "wait-for-release") {
      await new Promise<void>((resolve, reject) => {
        this.blockedExecutions.set(request.task.taskId, { resolve, reject });
        const waiters = this.blockedExecutionWaiters.get(request.task.taskId);
        this.blockedExecutionWaiters.delete(request.task.taskId);
        for (const resolve of waiters ?? []) resolve();
      });
    }
    const raw = Buffer.from(
      command === "emit-alpha-canary" || command === "emit-own-canary"
        ? ALPHA
        : command === "emit-public-marker"
          ? SECURE_OUTPUT_QUARANTINE
        : "safe",
    );
    const stdout = await request.guardOutput({
      stream: "stdout",
      bytes: raw,
      final: false,
    });
    await request.onOutput?.({ stream: "stdout", bytes: stdout });
    const tail = await request.guardOutput({
      stream: "stdout",
      bytes: Buffer.alloc(0),
      final: true,
    });
    await request.onOutput?.({ stream: "stdout", bytes: tail });
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: Buffer.alloc(0),
    };
  }

  hasBlockedExecution(taskId: string): boolean {
    return this.blockedExecutions.has(taskId);
  }

  async waitForBlockedExecution(taskId: string): Promise<void> {
    if (this.hasBlockedExecution(taskId)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.blockedExecutionWaiters.get(taskId) ?? new Set();
      waiters.add(resolve);
      this.blockedExecutionWaiters.set(taskId, waiters);
    });
  }

  rejectBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.reject(new Error("destroyed"));
  }

  releaseBlockedExecution(taskId: string): void {
    const blocked = this.blockedExecutions.get(taskId);
    this.blockedExecutions.delete(taskId);
    blocked?.resolve();
  }

  async destroyTask(task: SecureExecutionTask) {
    this.destroyed.push(task.taskId);
    if (this.options.destroyFailures?.includes(task.taskId)) {
      throw new Error("destroy failed");
    }
    if (this.destroyUnconfirmed.has(task.taskId)) {
      return false;
    }
    return true;
  }

  async recoverOrphans(liveTasks: readonly SecureExecutionTask[]) {
    this.recoveryCalls.push([...liveTasks]);
    if (this.recoveryFailures > 0) {
      this.recoveryFailures -= 1;
      throw new Error("recovery failed");
    }
    return { destroyedSandboxIds: [...(this.options.recoveredSandboxIds ?? [])] };
  }
}

function descriptor(agentId: string, profileId: string, cwd: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: "manager",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd,
    model: { provider: "openai", modelId: "test" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionSurface: "builder",
  } as AgentDescriptor;
}

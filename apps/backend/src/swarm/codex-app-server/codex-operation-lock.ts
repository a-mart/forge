import { CodexSidecarBusyError } from "./types.js";

export type CodexOperationKind = "sidecar_turn" | "direct_mcp_call";

export interface CodexOperationLease {
  kind: CodexOperationKind;
  ownerId: string;
}

export class CodexOperationLock {
  private activeLease: CodexOperationLease | undefined;

  getActiveLease(): CodexOperationLease | undefined {
    return this.activeLease;
  }

  assertAvailable(requested: CodexOperationLease): void {
    if (!this.activeLease) {
      return;
    }

    if (
      this.activeLease.kind === "sidecar_turn" &&
      requested.kind === "sidecar_turn" &&
      this.activeLease.ownerId === requested.ownerId
    ) {
      throw new CodexSidecarBusyError(this.activeLease.ownerId, requested.ownerId);
    }

    throw new CodexSidecarBusyError(this.activeLease.ownerId, requested.ownerId);
  }

  acquire(lease: CodexOperationLease): void {
    this.assertAvailable(lease);
    this.activeLease = lease;
  }

  release(lease: CodexOperationLease): void {
    if (
      this.activeLease?.kind === lease.kind &&
      this.activeLease.ownerId === lease.ownerId
    ) {
      this.activeLease = undefined;
    }
  }
}

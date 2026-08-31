import type {
  AgentDescriptor,
  GrantSecureSecretLeaseRequest,
  GrantSecureSecretLeasesRequest,
  ResolveSecureSecretAccessRequest,
  ResolveSecureSshHostTrustRequest,
  SecureSecretProviderSummary,
  SecureSecretAutomaticGrantPolicy,
  SecureSecretProviderTestResult,
  SecureSecretProjectDefaultSummary,
  SecureSecretSummary,
  SecureSshTrustedHostSummary,
  SecureSessionSnapshot,
  SecureSessionReadiness,
  SecureBrowserPrivateEntryChallenge,
  SecureBrowserSealedPrivateEntry,
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferRequest,
  ImportSecureVaultTransferResult,
} from "@forge/protocol";
import type { SwarmManagerFacadeServices } from "../swarm-manager-facade-services.js";
import { SwarmManagerGoalFacade } from "../swarm-manager-goal-facade.js";
import type { SecureRuntimeBinding } from "./runtime/secure-runtime-binding.js";
import type { SecureOrphanRecoveryResult } from "./execution/secure-execution-backend.js";
import type {
  ConnectBitwardenSecureSecretProviderInput,
  ApplySecureSessionProjectDefaultsInput,
  CreateLocalSecureSecretInput,
  CreateSecureSshTrustedHostInput,
  FulfillSecureAccessRequestInput,
  ImportBitwardenSecureSecretInput,
  RequestSecureSecretAccessInput,
  RequestSecureSshHostTrustInput,
  SecureSessionAgentView,
  StartSecureSessionInput,
  StopSecureSessionInput,
  UpdateBitwardenSecureSecretProviderCredentialInput,
  UpdateSecureSecretInput,
  UpdateSecureSshTrustedHostInput,
} from "./secure-sessions-api.js";

/**
 * Stateless public facade for the Secure Sessions service.
 *
 * Keeping this surface next to the service prevents the general manager facade
 * from becoming the feature owner and preserves the coordinator boundary.
 */
export abstract class SwarmManagerSecureSessionsFacade extends SwarmManagerGoalFacade {
  protected abstract getFacadeServices(): SwarmManagerFacadeServices;

  listSecureSecretProviders(): Promise<SecureSecretProviderSummary[]> {
    return this.secureSessions.listSecureSecretProviders();
  }

  exportSecureVaultTransfer(): Promise<ExportSecureVaultTransferResult> {
    return this.secureSessions.exportSecureVaultTransfer();
  }

  importSecureVaultTransfer(
    input: ImportSecureVaultTransferRequest,
  ): Promise<ImportSecureVaultTransferResult> {
    return this.secureSessions.importSecureVaultTransfer(input);
  }

  listSecureSshTrustedHosts(): Promise<SecureSshTrustedHostSummary[]> {
    return this.secureSessions.listSecureSshTrustedHosts();
  }

  createSecureSshTrustedHost(
    input: CreateSecureSshTrustedHostInput,
  ): Promise<SecureSshTrustedHostSummary> {
    return this.secureSessions.createSecureSshTrustedHost(input);
  }

  updateSecureSshTrustedHost(
    trustedHostId: string,
    input: UpdateSecureSshTrustedHostInput,
  ): Promise<SecureSshTrustedHostSummary> {
    return this.secureSessions.updateSecureSshTrustedHost(
      trustedHostId,
      input,
    );
  }

  deleteSecureSshTrustedHost(trustedHostId: string): Promise<boolean> {
    return this.secureSessions.deleteSecureSshTrustedHost(trustedHostId);
  }

  getSecureSessionReadiness(): Promise<SecureSessionReadiness> {
    return this.secureSessions.getSecureSessionReadiness();
  }

  installSecureRunner(): Promise<SecureSessionReadiness> {
    return this.secureSessions.installSecureRunner();
  }

  isSecurePrivateEntryAvailable(): Promise<boolean> {
    return this.secureSessions.isSecurePrivateEntryAvailable();
  }

  createRemotePrivateEntryChallenge(
    deviceId: string,
  ): Promise<SecureBrowserPrivateEntryChallenge> {
    return this.secureSessions.createRemotePrivateEntryChallenge(deviceId);
  }

  encryptRemotePrivateEntry(
    deviceId: string,
    sealedEntry: SecureBrowserSealedPrivateEntry,
  ): Promise<string> {
    return this.secureSessions.encryptRemotePrivateEntry(deviceId, sealedEntry);
  }

  encryptTrustedBrowserPrivateEntry(encodedValue: string): Promise<string> {
    return this.secureSessions.encryptTrustedBrowserPrivateEntry(encodedValue);
  }

  connectBitwardenSecureSecretProvider(
    input: ConnectBitwardenSecureSecretProviderInput,
  ): Promise<SecureSecretProviderSummary> {
    return this.secureSessions.connectBitwardenSecureSecretProvider(input);
  }

  testSecureSecretProvider(providerId: string): Promise<SecureSecretProviderTestResult> {
    return this.secureSessions.testSecureSecretProvider(providerId);
  }

  updateBitwardenSecureSecretProviderCredential(
    providerId: string,
    input: UpdateBitwardenSecureSecretProviderCredentialInput,
  ): Promise<SecureSecretProviderSummary> {
    return this.secureSessions.updateBitwardenSecureSecretProviderCredential(
      providerId,
      input,
    );
  }

  deleteSecureSecretProvider(providerId: string): Promise<void> {
    return this.secureSessions.deleteSecureSecretProvider(providerId);
  }

  importBitwardenSecureSecret(
    providerId: string,
    input: ImportBitwardenSecureSecretInput,
  ): Promise<SecureSecretSummary> {
    return this.secureSessions.importBitwardenSecureSecret(providerId, input);
  }

  listSecureSecrets(): Promise<SecureSecretSummary[]> {
    return this.secureSessions.listSecureSecrets();
  }

  listSecureSecretProjectDefaults(
    profileId?: string,
  ): Promise<SecureSecretProjectDefaultSummary[]> {
    return this.secureSessions.listSecureSecretProjectDefaults(profileId);
  }

  setSecureSecretProjectDefault(
    secretId: string,
    input: { profileId: string; enabled: boolean },
  ): Promise<SecureSecretProjectDefaultSummary | null> {
    return this.secureSessions.setSecureSecretProjectDefault(secretId, input);
  }

  replaceSecureSecretAutomaticGrantPolicy(
    secretId: string,
    policy: SecureSecretAutomaticGrantPolicy,
  ): Promise<SecureSecretSummary> {
    return this.secureSessions.replaceSecureSecretAutomaticGrantPolicy(
      secretId,
      policy,
    );
  }

  createLocalSecureSecret(input: CreateLocalSecureSecretInput): Promise<SecureSecretSummary> {
    return this.secureSessions.createLocalSecureSecret(input);
  }

  updateSecureSecret(
    secretId: string,
    input: UpdateSecureSecretInput,
  ): Promise<SecureSecretSummary> {
    return this.secureSessions.updateSecureSecret(secretId, input);
  }

  deleteSecureSecret(secretId: string): Promise<void> {
    return this.secureSessions.deleteSecureSecret(secretId);
  }

  getSecureSessionSnapshot(sessionAgentId: string): Promise<SecureSessionSnapshot> {
    return this.secureSessions.getSecureSessionSnapshot(sessionAgentId);
  }

  startSecureSession(
    sessionAgentId: string,
    input: StartSecureSessionInput = {},
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.startSecureSession(sessionAgentId, input);
  }

  stopSecureSession(
    sessionAgentId: string,
    input: StopSecureSessionInput,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.stopSecureSession(sessionAgentId, input);
  }

  applySecureSessionProjectDefaults(
    sessionAgentId: string,
    input: ApplySecureSessionProjectDefaultsInput,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.applySecureSessionProjectDefaults(
      sessionAgentId,
      input,
    );
  }

  isTeamSecureMode(managerAgentId: string): boolean {
    return this.secureSessions.isTeamSecureMode(managerAgentId);
  }

  listSecureSessionTeamSnapshots(
    managerAgentId: string,
  ): Promise<SecureSessionSnapshot[]> {
    return this.secureSessions.listSecureSessionTeamSnapshots(managerAgentId);
  }

  prepareWorkerForSecureTeam(workerAgentId: string): Promise<boolean> {
    return this.secureSessions.prepareWorkerForSecureTeam(workerAgentId);
  }

  advanceWorkerSecureAssignment(
    workerAgentId: string,
    assignmentId: string,
  ): Promise<void> {
    return this.secureSessions.advanceWorkerSecureAssignment(
      workerAgentId,
      assignmentId,
    );
  }

  grantSecureSessionLease(
    sessionAgentId: string,
    input: GrantSecureSecretLeaseRequest,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.grantSecureSessionLease(sessionAgentId, input);
  }

  grantSecureSessionLeases(
    sessionAgentId: string,
    input: GrantSecureSecretLeasesRequest,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.grantSecureSessionLeases(sessionAgentId, input);
  }

  revokeSecureSessionLease(
    sessionAgentId: string,
    input: { baseRevision: number; leaseId: string },
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.revokeSecureSessionLease(sessionAgentId, input);
  }

  resolveSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: ResolveSecureSecretAccessRequest,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.resolveSecureAccessRequest(sessionAgentId, requestId, input);
  }

  fulfillSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: FulfillSecureAccessRequestInput,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.fulfillSecureAccessRequest(sessionAgentId, requestId, input);
  }

  getSecureSessionAgentView(callerAgentId: string): Promise<SecureSessionAgentView> {
    return this.secureSessions.getSecureSessionAgentView(callerAgentId);
  }

  requestSecureSecretAccess(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSecretAccessInput,
  ): Promise<"requested" | "already_requested" | "already_granted"> {
    return this.secureSessions.requestSecureSecretAccess(callerAgentId, toolCallId, input);
  }

  requestSecureSshHostTrust(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSshHostTrustInput,
  ): Promise<"trusted" | "requested"> {
    return this.secureSessions.requestSecureSshHostTrust(
      callerAgentId,
      toolCallId,
      input,
    );
  }

  resolveSecureSshHostTrustRequest(
    sessionAgentId: string,
    input: ResolveSecureSshHostTrustRequest,
  ): Promise<SecureSessionSnapshot> {
    return this.secureSessions.resolveSecureSshHostTrustRequest(
      sessionAgentId,
      input,
    );
  }

  getSecureRuntimeBinding(
    descriptor: AgentDescriptor,
    runtimeToken?: number,
  ): SecureRuntimeBinding | undefined {
    return this.secureSessions.getSecureRuntimeBinding(descriptor, runtimeToken);
  }

  initializeSecureSessions(): Promise<SecureOrphanRecoveryResult> {
    return this.secureSessions.initializeSecureSessions();
  }

  closeSecureSessions(): Promise<void> {
    return this.secureSessions.closeSecureSessions();
  }

  private get secureSessions() {
    return this.getFacadeServices().secureSessions;
  }
}

import type { SecureSecretBinding } from "@forge/protocol";
import type { SecureExecutionDelivery } from "./secure-execution-backend.js";
import { SecureExecutionError } from "./secure-execution-error.js";

export interface ResolvedSecureSecretBinding {
  binding: SecureSecretBinding;
  value: Uint8Array;
  /**
   * Optional backend-only convenience for file bindings. The protocol's exact
   * targetPath is still honored.
   */
  pathEnvironmentVariable?: string;
}

/**
 * Converts value-free public binding metadata plus host-resolved bytes into
 * the provider-neutral executor delivery shape.
 *
 * SSH-agent bindings require a brokered socket and are deliberately rejected
 * by this raw-material Docker proof instead of silently becoming a file.
 */
export function createExecutionDeliveryFromBindings(
  resolved: readonly ResolvedSecureSecretBinding[],
): SecureExecutionDelivery {
  const environment: Array<{
    name: string;
    value: Uint8Array;
  }> = [];
  const ramFiles: Array<{
    targetPath: string;
    value: Uint8Array;
    fileMode: 0o400 | 0o600;
    pathEnvironmentVariable?: string;
  }> = [];
  const askpass: Array<{
    targetName: string;
    value: Uint8Array;
  }> = [];
  let stdin: Uint8Array | undefined;

  for (const item of resolved) {
    switch (item.binding.deliveryKind) {
      case "environment":
        environment.push({
          name: item.binding.targetName,
          value: item.value,
        });
        break;
      case "stdin":
        if (stdin !== undefined) {
          throw new SecureExecutionError("INVALID_DELIVERY");
        }
        stdin = item.value;
        break;
      case "file": {
        const fileMode = item.binding.fileMode ?? 0o400;
        if (fileMode !== 0o400 && fileMode !== 0o600) {
          throw new SecureExecutionError("INVALID_DELIVERY");
        }
        ramFiles.push({
          targetPath: item.binding.targetPath,
          value: item.value,
          fileMode,
          ...(item.pathEnvironmentVariable
            ? { pathEnvironmentVariable: item.pathEnvironmentVariable }
            : {}),
        });
        break;
      }
      case "askpass":
        askpass.push({
          targetName: item.binding.targetName,
          value: item.value,
        });
        break;
      case "ssh_agent":
        throw new SecureExecutionError("INVALID_DELIVERY");
    }
  }

  return {
    environment,
    ramFiles,
    askpass,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

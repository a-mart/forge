/**
 * Providers that must never receive Secure Sessions grants or runtime setup.
 * `claude-sdk` is retained only as an unsupported compatibility tombstone for
 * unknown persisted legacy descriptors that remain unavailable after retirement.
 */
const UNSUPPORTED_SECURE_RUNTIME_PROVIDERS = new Set([
  "claude-sdk",
  "cursor-sdk",
  "cursor-acp",
]);

export function supportsSecureRuntimeProvider(provider: string): boolean {
  return !UNSUPPORTED_SECURE_RUNTIME_PROVIDERS.has(
    provider.trim().toLowerCase(),
  );
}

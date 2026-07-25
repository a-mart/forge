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

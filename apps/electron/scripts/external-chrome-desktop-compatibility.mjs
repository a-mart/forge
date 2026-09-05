/**
 * Persist unused Desktop-range metadata so historical package manifests remain
 * parseable. Runtime compatibility is protocol, shell ABI, platform, and hash
 * integrity; this range is never a gate.
 */
export function unusedDesktopCompatibilityMetadata() {
  return { min: '0.0.0', max: '999.999.999' }
}

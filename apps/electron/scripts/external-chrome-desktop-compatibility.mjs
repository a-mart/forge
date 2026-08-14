const DESKTOP_VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/u

/**
 * Derive the Desktop compatibility range for a generated External Chrome package.
 *
 * The range follows the intended Desktop major/minor of the package being staged,
 * so a 0.23 Desktop build is not rejected by a leftover 0.22.999 cap. Minimum
 * and maximum stay on that same line: older majors/minors remain incompatible,
 * and signed/hash-pinned package invariants are unchanged.
 */
export function desktopCompatibilityFromVersion(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('External Chrome desktop compatibility requires a Desktop version')
  }
  const match = version.trim().match(DESKTOP_VERSION_PATTERN)
  if (!match) {
    throw new Error(`External Chrome desktop compatibility cannot parse Desktop version ${version}`)
  }
  const [, major, minor] = match
  return {
    min: `${major}.${minor}.0`,
    max: `${major}.${minor}.999`,
  }
}

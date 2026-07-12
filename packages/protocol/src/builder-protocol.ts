/**
 * Builder (remote projects) protocol versioning.
 *
 * A single integer, following the `CLI_PROTOCOL_VERSION` precedent in
 * `cli.ts`: events and commands are additive-only; any removal or repurpose
 * of existing wire surface bumps this number. Clients refuse to attach the
 * builder surface to a server whose version exceeds their ceiling and render
 * an "update Forge to connect" state instead.
 */
export const BUILDER_PROTOCOL_VERSION = 2 as const

/** Highest builder protocol version this client build can attach to. */
export const BUILDER_PROTOCOL_MAX_SUPPORTED = 2

export type BuilderProtocolVersion = typeof BUILDER_PROTOCOL_VERSION

/**
 * Capability flags advertised by an instance in the `/api/collaboration/status`
 * handshake. Additive-only: absent flags mean "not supported".
 */
export interface BuilderInstanceCapabilities {
  /** Collaboration surface (channels) is available on this instance. */
  collab: boolean
  /** Remote projects (member builder access) is enabled on this instance. */
  remoteBuild: boolean
  /**
   * Server can create a single directory level via `create_directory`.
   * Absent/false on older servers — UI should hide "+ New folder".
   */
  createDirectory?: boolean
}

import {
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
} from '@forge/protocol'

/** Chrome permits 64 MiB extension-to-host; Forge intentionally accepts much less. */
export const HOST_MAX_NATIVE_INBOUND_BYTES = 8 * 1_024 * 1_024
/** Chrome permits 1 MiB host-to-extension; Forge intentionally emits much less. */
export const HOST_MAX_NATIVE_OUTBOUND_BYTES = 512 * 1_024
/** Relay negotiation is stricter than either native messaging direction. */
export const HOST_MAX_NEGOTIATED_MESSAGE_BYTES = 256 * 1_024
export const HOST_MAX_RELAY_RECORD_BYTES = 384 * 1_024
/** A stalled relay consumer may retain at most this many fully decoded records. */
export const HOST_MAX_QUEUED_RELAY_RECORDS = 32
/** Aggregate decoded JSON bytes retained while the relay consumer is stalled. */
export const HOST_MAX_QUEUED_RELAY_BYTES = 2 * 1_024 * 1_024
export const HOST_MAX_DESKTOP_UNAVAILABLE_BYTES = 1_024

export const HOST_PROTOCOL_MIN_VERSION = EXTERNAL_CHROME_PROTOCOL_MIN_VERSION
export const HOST_PROTOCOL_MAX_VERSION = EXTERNAL_CHROME_PROTOCOL_MAX_VERSION
export const HOST_EXTENSION_ORIGIN = EXTERNAL_CHROME_EXTENSION_ORIGIN

export const HOST_CONNECT_MAX_ATTEMPTS = 3
export const HOST_CONNECT_RETRY_DELAY_MS = 25
export const HOST_CONNECT_BUDGET_MS = 250

/**
 * API helpers for the CLI Access settings surface.
 *
 * Wraps `/api/settings/cli-access/*` endpoints using the shared settings
 * API client so credentials/base-URL resolve automatically.
 */

import type {
  CliAccessKeyCreatedResponse,
  CliAccessKeyDescriptor,
  CliAccessKeyListResponse,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

const KEYS_ENDPOINT = '/api/settings/cli-access/keys'

/** List all CLI access keys (active and revoked). */
export async function fetchCliAccessKeys(
  client: SettingsApiClient,
): Promise<CliAccessKeyDescriptor[]> {
  const result = await client.fetchJson<CliAccessKeyListResponse>(KEYS_ENDPOINT)
  return result.keys
}

/** Generate a new CLI access key. The plaintext key is returned exactly once. */
export async function generateCliAccessKey(
  client: SettingsApiClient,
  options?: { name?: string },
): Promise<CliAccessKeyCreatedResponse> {
  return client.fetchJson<CliAccessKeyCreatedResponse>(KEYS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: options?.name }),
  })
}

/** Revoke a CLI access key by id. */
export async function revokeCliAccessKey(
  client: SettingsApiClient,
  keyId: string,
): Promise<{ key: CliAccessKeyDescriptor }> {
  return client.fetchJson<{ key: CliAccessKeyDescriptor }>(`${KEYS_ENDPOINT}/${encodeURIComponent(keyId)}`, {
    method: 'DELETE',
  })
}

/** Rotate a CLI access key — revokes the old key and returns a new one. */
export async function rotateCliAccessKey(
  client: SettingsApiClient,
  keyId: string,
  options?: { name?: string },
): Promise<CliAccessKeyCreatedResponse> {
  return client.fetchJson<CliAccessKeyCreatedResponse>(
    `${KEYS_ENDPOINT}/${encodeURIComponent(keyId)}/rotate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: options?.name }),
    },
  )
}

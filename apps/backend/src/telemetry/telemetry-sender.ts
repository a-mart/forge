import type { TelemetryPayload } from '@forge/protocol'

const TELEMETRY_ENDPOINT = 'https://telemetry.forge-app.workers.dev/v1/report'
const TELEMETRY_TIMEOUT_MS = 10_000
const TELEMETRY_MAX_RETRIES = 2

export async function sendTelemetryPayload(payload: TelemetryPayload): Promise<boolean> {
  for (let attempt = 0; attempt <= TELEMETRY_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
      })

      if (response.ok) {
        return true
      }

      if (response.status === 400 || response.status === 413) {
        return false
      }
    } catch {
      // Retry below.
    }

    if (attempt < TELEMETRY_MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }
  }

  return false
}

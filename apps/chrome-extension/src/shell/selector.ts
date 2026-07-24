export interface PayloadSelector {
  schemaVersion: 1
  shellAbi: 1
  payloadVersion: string
  payloadSha256: string
  payloadDirectory: string
}

const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/

export function parsePayloadSelector(value: unknown): PayloadSelector {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload selector must be an object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = ['payloadDirectory', 'payloadSha256', 'payloadVersion', 'schemaVersion', 'shellAbi']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('payload selector fields do not match shell ABI')
  if (record.schemaVersion !== 1 || record.shellAbi !== 1) throw new Error('payload selector ABI is unsupported')
  if (typeof record.payloadVersion !== 'string' || !SAFE_VERSION.test(record.payloadVersion)) throw new Error('payload version is invalid')
  if (typeof record.payloadSha256 !== 'string' || !SHA256.test(record.payloadSha256)) throw new Error('payload hash is invalid')
  const expectedDirectory = `${record.payloadVersion}-${record.payloadSha256}`
  if (record.payloadDirectory !== expectedDirectory) throw new Error('payload directory does not bind version and hash')
  return record as unknown as PayloadSelector
}

export async function loadPayloadSelector(getUrl: (path: string) => string, fetchValue: typeof fetch = fetch): Promise<PayloadSelector> {
  const response = await fetchValue(getUrl('current.json'), { cache: 'no-store', credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error(`payload selector returned ${response.status}`)
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > 4_096) throw new Error('payload selector exceeds shell bound')
  return parsePayloadSelector(JSON.parse(text) as unknown)
}

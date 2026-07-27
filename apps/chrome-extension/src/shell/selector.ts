export interface PayloadSelector {
  schemaVersion: 1
  shellAbi: 1
  payloadVersion: string
  payloadSha256: string
  payloadDirectory: string
  payloadFiles: Record<'content-script.js' | 'service-worker.js', string>
}

const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/

export function parsePayloadSelector(value: unknown): PayloadSelector {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload selector must be an object')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = ['payloadDirectory', 'payloadFiles', 'payloadSha256', 'payloadVersion', 'schemaVersion', 'shellAbi']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('payload selector fields do not match shell ABI')
  if (record.schemaVersion !== 1 || record.shellAbi !== 1) throw new Error('payload selector ABI is unsupported')
  if (typeof record.payloadVersion !== 'string' || !SAFE_VERSION.test(record.payloadVersion)) throw new Error('payload version is invalid')
  if (typeof record.payloadSha256 !== 'string' || !SHA256.test(record.payloadSha256)) throw new Error('payload hash is invalid')
  const expectedDirectory = `${record.payloadVersion}-${record.payloadSha256}`
  if (record.payloadDirectory !== expectedDirectory) throw new Error('payload directory does not bind version and hash')
  if (typeof record.payloadFiles !== 'object' || record.payloadFiles === null || Array.isArray(record.payloadFiles)) throw new Error('payload file metadata is invalid')
  const payloadFiles = record.payloadFiles as Record<string, unknown>
  const expectedFiles = ['content-script.js', 'service-worker.js']
  const fileNames = Object.keys(payloadFiles).sort()
  if (fileNames.length !== expectedFiles.length || fileNames.some((name, index) => name !== expectedFiles[index])) throw new Error('payload file metadata is incomplete')
  for (const name of expectedFiles) if (typeof payloadFiles[name] !== 'string' || !SHA256.test(payloadFiles[name])) throw new Error(`payload hash is invalid for ${name}`)
  return record as unknown as PayloadSelector
}

const MAX_SELECTOR_BYTES = 8_192
const MAX_PAYLOAD_FILE_BYTES = 2 * 1_024 * 1_024

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function payloadResourcePath(
  selector: PayloadSelector,
  entry: keyof PayloadSelector['payloadFiles'],
): string {
  if (!(entry in selector.payloadFiles)) throw new Error('selected payload entry is not declared')
  return `payloads/${selector.payloadDirectory}/${entry}`
}

export async function loadPayloadSelector(getUrl: (path: string) => string, fetchValue: typeof fetch = fetch): Promise<PayloadSelector> {
  const response = await fetchValue(getUrl('current.json'), { cache: 'no-store', credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error(`payload selector returned ${response.status}`)
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_SELECTOR_BYTES) throw new Error('payload selector exceeds shell bound')
  return parsePayloadSelector(JSON.parse(text) as unknown)
}

/** Verifies every selected payload byte before returning a URL that may be executed. */
export async function loadVerifiedPayloadSelector(
  getUrl: (path: string) => string,
  selectedEntry: keyof PayloadSelector['payloadFiles'],
  fetchValue: typeof fetch = fetch,
): Promise<PayloadSelector> {
  const selector = await loadPayloadSelector(getUrl, fetchValue)
  payloadResourcePath(selector, selectedEntry)
  await Promise.all(Object.entries(selector.payloadFiles).map(async ([fileName, expectedHash]) => {
    const resourcePath = payloadResourcePath(selector, fileName as keyof PayloadSelector['payloadFiles'])
    const response = await fetchValue(getUrl(resourcePath), { cache: 'no-store', credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new Error(`payload file unavailable: ${fileName}`)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_PAYLOAD_FILE_BYTES) throw new Error(`payload file exceeds shell bound: ${fileName}`)
    if (await sha256Hex(bytes) !== expectedHash) throw new Error(`payload integrity mismatch: ${fileName}`)
  }))
  return selector
}

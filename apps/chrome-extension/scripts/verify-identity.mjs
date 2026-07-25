import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_EXTENSION_ID = 'fcchfcnadajoejfbiclihglkmbcfhajd'
export const EXPECTED_PUBLIC_KEY_SHA256 = '522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93'

export function deriveChromeExtensionId(publicKeyDer) {
  const prefix = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16)
  return [...prefix].flatMap((byte) => [byte >> 4, byte & 0x0f]).map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble)).join('')
}

export async function verifyIdentity(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const publicKeyText = (await readFile(path.join(root, 'identity/production-public-key.b64'), 'utf8')).trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyText)) throw new Error('public identity is not canonical base64')
  const publicKeyDer = Buffer.from(publicKeyText, 'base64')
  const publicKeySha256 = createHash('sha256').update(publicKeyDer).digest('hex')
  const extensionId = deriveChromeExtensionId(publicKeyDer)
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.shell.json'), 'utf8'))
  if (publicKeySha256 !== EXPECTED_PUBLIC_KEY_SHA256) throw new Error(`public key hash mismatch: ${publicKeySha256}`)
  if (extensionId !== EXPECTED_EXTENSION_ID) throw new Error(`extension ID mismatch: ${extensionId}`)
  if (manifest.key !== publicKeyText) throw new Error('manifest key does not equal pinned public material')
  return { extensionId, publicKeySha256, publicKeyBase64: publicKeyText }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await verifyIdentity()
  process.stdout.write(`${JSON.stringify({ extensionId: result.extensionId, publicKeySha256: result.publicKeySha256 })}\n`)
}

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

export async function sortedFiles(root) {
  const result = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden in package input: ${absolute}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  await visit(root)
  return result
}

export async function hashTree(root, files) {
  const selectedFiles = files ?? await sortedFiles(root)
  const hash = createHash('sha256')
  for (const relative of selectedFiles) {
    const content = await readFile(path.join(root, relative))
    hash.update(`${relative}\0${content.byteLength}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

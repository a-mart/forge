import { generateManifest, type Manifest } from 'material-icon-theme'

const manifest: Manifest = generateManifest()

const fileExtensions = manifest.fileExtensions ?? {}
const fileNames = manifest.fileNames ?? {}
const folderNames = manifest.folderNames ?? {}
const folderNamesExpanded = manifest.folderNamesExpanded ?? {}

const defaultFileIcon = manifest.file ?? 'file'
const defaultFolderIcon = manifest.folder ?? 'folder'
const defaultFolderExpandedIcon = manifest.folderExpanded ?? 'folder-open'

// VS Code language-level defaults are not fully represented in fileExtensions.
// These extension fallbacks cover the common source-file set used in repos.
const commonExtensionFallbacks: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'react',
  tsx: 'react_ts',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  lock: 'lock',
  env: 'tune',
  sh: 'console',
  zsh: 'console',
  bash: 'console',
  fish: 'console',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  css: 'css',
  scss: 'sass',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
}

const commonFileNameFallbacks: Record<string, string> = {
  dockerfile: 'docker',
  'docker-compose.yml': 'docker-compose',
  'docker-compose.yaml': 'docker-compose',
  'package.json': 'nodejs',
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  makefile: 'settings',
  'readme.md': 'readme',
  readme: 'readme',
  'tsconfig.json': 'tsconfig',
}

const commonFolderFallbacks: Record<string, { closed: string; open: string }> = {
  src: { closed: 'folder-src', open: 'folder-src-open' },
  lib: { closed: 'folder-lib', open: 'folder-lib-open' },
  test: { closed: 'folder-test', open: 'folder-test-open' },
  tests: { closed: 'folder-test', open: 'folder-test-open' },
  '__tests__': { closed: 'folder-test', open: 'folder-test-open' },
  '.github': { closed: 'folder-github', open: 'folder-github-open' },
  node_modules: { closed: 'folder-node', open: 'folder-node-open' },
  dist: { closed: 'folder-dist', open: 'folder-dist-open' },
  build: { closed: 'folder-dist', open: 'folder-dist-open' },
}

function resolveByExtension(fileName: string): string | undefined {
  const lower = fileName.toLowerCase()
  const parts = lower.split('.')

  if (parts.length <= 1) {
    return undefined
  }

  // Prefer longest dotted extension first: "d.ts" before "ts".
  for (let i = 1; i < parts.length; i += 1) {
    const ext = parts.slice(i).join('.')
    const fromManifest = fileExtensions[ext]
    if (fromManifest) {
      return fromManifest
    }

    const fromFallback = commonExtensionFallbacks[ext]
    if (fromFallback) {
      return fromFallback
    }
  }

  return undefined
}

export function getFileIconName(
  fileName: string,
  isDirectory: boolean,
  isExpanded = false,
): string {
  const lowerName = fileName.toLowerCase()

  if (isDirectory) {
    const specialFolder = commonFolderFallbacks[lowerName]
    if (specialFolder) {
      return isExpanded ? specialFolder.open : specialFolder.closed
    }

    if (isExpanded) {
      return (
        folderNamesExpanded[lowerName] ??
        folderNames[lowerName] ??
        defaultFolderExpandedIcon
      )
    }

    return folderNames[lowerName] ?? defaultFolderIcon
  }

  const fileNameMatch =
    fileNames[lowerName] ?? commonFileNameFallbacks[lowerName]
  if (fileNameMatch) {
    return fileNameMatch
  }

  const extensionMatch = resolveByExtension(fileName)
  if (extensionMatch) {
    return extensionMatch
  }

  return defaultFileIcon
}

import hljs from 'highlight.js/lib/core'

// Register languages individually for smaller bundle
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml' // covers HTML + JSX
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini' // covers TOML
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('diff', diff)

/** Map file extensions to highlight.js language identifiers */
const extensionToLanguage: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Data
  json: 'json',
  jsonl: 'json',
  // Styles
  css: 'css',
  scss: 'css',
  // Markup
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  // Docs
  md: 'markdown',
  mdx: 'markdown',
  // Python
  py: 'python',
  pyw: 'python',
  // Shell
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  // Config
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  // Other languages
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  diff: 'diff',
  patch: 'diff',
}

/** Known filenames that map to specific languages */
const filenameToLanguage: Record<string, string> = {
  Dockerfile: 'bash',
  Makefile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.gitignore': 'bash',
  '.env': 'bash',
  '.env.example': 'bash',
}

/**
 * Detect the highlight.js language from a file path.
 * Returns undefined if no language matches (will render as plain text).
 */
export function detectLanguage(fileName: string): string | undefined {
  // Check exact filename matches first
  const baseName = fileName.split('/').pop() ?? fileName
  if (filenameToLanguage[baseName]) {
    return filenameToLanguage[baseName]
  }

  // Extract extension
  const ext = baseName.split('.').pop()?.toLowerCase()
  if (ext && extensionToLanguage[ext]) {
    return extensionToLanguage[ext]
  }

  return undefined
}

/**
 * Highlight a single line of code. Returns an HTML string with syntax
 * highlighting spans, or the original text if no language is detected.
 */
export function highlightCode(source: string, language: string | undefined): string {
  if (!language) return escapeHtml(source)

  try {
    const result = hljs.highlight(source, { language, ignoreIllegals: true })
    return result.value
  } catch {
    // Fallback to plain text on any error
    return escapeHtml(source)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { hljs }

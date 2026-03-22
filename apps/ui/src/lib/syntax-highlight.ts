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
// Additional languages for file browser
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import scala from 'highlight.js/lib/languages/scala'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

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
hljs.registerLanguage('java', java)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('php', php)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('dockerfile', dockerfile)

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
  markdown: 'markdown',
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
  // Additional languages
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hxx: 'cpp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
}

/** Known filenames that map to specific languages */
const filenameToLanguage: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.gitignore': 'bash',
  '.env': 'bash',
  '.env.example': 'bash',
}

/**
 * Human-readable language names for display in status bars etc.
 */
const languageDisplayNames: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  xml: 'HTML',
  markdown: 'Markdown',
  python: 'Python',
  bash: 'Shell',
  yaml: 'YAML',
  ini: 'TOML',
  sql: 'SQL',
  go: 'Go',
  rust: 'Rust',
  diff: 'Diff',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  scala: 'Scala',
  dockerfile: 'Dockerfile',
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
 * Get a human-readable language name for display.
 */
export function getLanguageDisplayName(language: string | undefined): string | undefined {
  if (!language) return undefined
  return languageDisplayNames[language]
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

import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

export function codeMirrorLanguageExtension(language: string | undefined): Extension {
  const normalized = language?.trim().toLowerCase()
  switch (normalized) {
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css()
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return html()
    case 'javascript':
    case 'js':
    case 'jsx':
    case 'typescript':
    case 'ts':
    case 'tsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: normalized === 'jsx' || normalized === 'tsx', typescript: normalized === 'typescript' || normalized === 'ts' || normalized === 'tsx' })
    case 'json':
    case 'jsonc':
    case 'jsonl':
      return json()
    case 'markdown':
    case 'md':
    case 'mdx':
      return markdown()
    case 'dockerfile':
      return StreamLanguage.define(dockerFile)
    case 'bash':
    case 'shell':
    case 'sh':
    case 'zsh':
    case 'fish':
      return StreamLanguage.define(shell)
    case 'yaml':
    case 'yml':
      return StreamLanguage.define(yaml)
    default:
      return []
  }
}

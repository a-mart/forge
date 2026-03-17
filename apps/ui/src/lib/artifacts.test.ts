import { describe, expect, it } from 'vitest'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  toSwarmFileHref,
  toVscodeInsidersHref,
} from './artifacts'

describe('artifacts helpers', () => {
  it('normalizes [artifact:path] shortcodes into swarm-file links', () => {
    const normalized = normalizeArtifactShortcodes('See [artifact:/tmp/test.md] for details.')

    expect(normalized).toBe('See [artifact:/tmp/test.md](swarm-file:///tmp/test.md) for details.')
  })

  it('parses swarm-file links into artifact references', () => {
    const artifact = parseArtifactReference('swarm-file:///Users/example/project/README.md')

    expect(artifact).toEqual({
      path: '/Users/example/project/README.md',
      fileName: 'README.md',
      href: 'swarm-file:///Users/example/project/README.md',
    })
  })

  it('parses vscode insiders file links into artifact references', () => {
    const artifact = parseArtifactReference('vscode-insiders://file//Users/example/project/SWARM.md')

    expect(artifact).toEqual({
      path: '/Users/example/project/SWARM.md',
      fileName: 'SWARM.md',
      href: 'vscode-insiders://file//Users/example/project/SWARM.md',
    })
  })

  it('normalizes Windows swarm-file and vscode artifact paths', () => {
    expect(parseArtifactReference('swarm-file:///C:/Users/example/project/README.md')).toEqual({
      path: 'C:/Users/example/project/README.md',
      fileName: 'README.md',
      href: 'swarm-file:///C:/Users/example/project/README.md',
    })

    expect(parseArtifactReference('vscode-insiders://file//C:/Users/example/project/README.md')).toEqual({
      path: 'C:/Users/example/project/README.md',
      fileName: 'README.md',
      href: 'vscode-insiders://file//C:/Users/example/project/README.md',
    })
  })

  it('parses local file paths into artifact references', () => {
    const artifact = parseArtifactReference('docs/plans/terminal-support.md')

    expect(artifact).toEqual({
      path: 'docs/plans/terminal-support.md',
      fileName: 'terminal-support.md',
      href: 'docs/plans/terminal-support.md',
    })
  })

  it('uses markdown link text as a display title when provided', () => {
    const artifact = parseArtifactReference('./docs/plans/terminal-support.md', {
      title: 'Terminal Support Plan',
    })

    expect(artifact).toEqual({
      path: './docs/plans/terminal-support.md',
      fileName: 'terminal-support.md',
      href: './docs/plans/terminal-support.md',
      title: 'Terminal Support Plan',
    })
  })

  it('does not treat external links as artifacts', () => {
    expect(parseArtifactReference('https://example.com/docs/plan.md')).toBeNull()
    expect(parseArtifactReference('mailto:test@example.com')).toBeNull()
    expect(parseArtifactReference('example.com/docs/plan.md')).toBeNull()
  })

  it('builds artifact href helpers', () => {
    expect(toSwarmFileHref('/tmp/my notes.md')).toBe('swarm-file:///tmp/my%20notes.md')
    expect(toSwarmFileHref('C:/Users/example/my notes.md')).toBe(
      'swarm-file:///C:/Users/example/my%20notes.md',
    )
    expect(toVscodeInsidersHref('/tmp/my notes.md')).toBe('vscode-insiders://file/tmp/my%20notes.md')
    expect(toVscodeInsidersHref('C:/Users/example/my notes.md')).toBe(
      'vscode-insiders://file/C:/Users/example/my%20notes.md',
    )
  })
})

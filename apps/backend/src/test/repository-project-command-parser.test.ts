import { describe, expect, it } from 'vitest'
import { extractRequestId, parseClientCommand } from '../ws/ws-command-parser.js'

describe('ws-command-parser repository project lifecycle', () => {
  it('requires requestId on create_repository_project', () => {
    const missing = parseClientCommand(
      JSON.stringify({
        type: 'create_repository_project',
        name: 'Proj',
        repositoryUrl: 'https://github.com/org/repo.git',
        repositoryBasePath: '/tmp',
        repositoryFolder: 'repo',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
      }),
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error).toMatch(/requestId/)
    }
  })

  it('parses create and cancel commands and extracts request ids', () => {
    const create = parseClientCommand(
      JSON.stringify({
        type: 'create_repository_project',
        name: 'Proj',
        repositoryUrl: 'https://github.com/org/repo.git',
        repositoryBasePath: '/tmp',
        repositoryFolder: 'repo',
        modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
        requestId: 'create-1',
      }),
    )
    expect(create.ok).toBe(true)
    if (create.ok) {
      expect(create.command.type).toBe('create_repository_project')
      expect(extractRequestId(create.command)).toBe('create-1')
    }

    const cancel = parseClientCommand(
      JSON.stringify({
        type: 'cancel_repository_project_creation',
        operationRequestId: 'create-1',
        requestId: 'cancel-1',
      }),
    )
    expect(cancel.ok).toBe(true)
    if (cancel.ok) {
      expect(cancel.command.type).toBe('cancel_repository_project_creation')
      expect(extractRequestId(cancel.command)).toBe('cancel-1')
    }
  })
})

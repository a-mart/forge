import { describe, expect, it } from 'vitest'
import { collectArtifactsFromMessages } from './collect-artifacts'
import type { ConversationEntry } from '@forge/protocol'

function assistantMessage(text: string, id?: string, agentId = 'manager'): ConversationEntry {
  return {
    type: 'conversation_message',
    ...(id ? { id } : {}),
    agentId,
    role: 'assistant',
    text,
    timestamp: '2026-02-25T00:00:00.000Z',
    source: 'speak_to_user',
  }
}

function agentMessage(text: string): ConversationEntry {
  return {
    type: 'agent_message',
    agentId: 'manager',
    fromAgentId: 'worker-1',
    toAgentId: 'manager',
    source: 'agent_to_agent',
    text,
    timestamp: '2026-02-25T00:00:01.000Z',
  }
}

function agentToolCallEnd(text: string, toolName = 'export_scoped_codex_plugin_result'): ConversationEntry {
  return {
    type: 'agent_tool_call',
    agentId: 'manager',
    actorAgentId: 'codex-plugin-fireflies',
    kind: 'tool_execution_end',
    toolName,
    toolCallId: 'tool-1',
    text,
    timestamp: '2026-02-25T00:00:02.000Z',
  }
}

describe('collectArtifactsFromMessages', () => {
  it('collects local markdown links as artifacts and keeps link text as title', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('[Terminal Support Plan](docs/plans/terminal-support.md)'),
    ])

    expect(artifacts).toEqual([
      {
        path: 'docs/plans/terminal-support.md',
        fileName: 'terminal-support.md',
        href: 'docs/plans/terminal-support.md',
        title: 'Terminal Support Plan',
        sourceAgentId: 'manager',
      },
    ])
  })

  it('ignores markdown image links when collecting artifacts', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('![Diagram](docs/images/diagram.png)\n[Build Plan](docs/plans/build.md)'),
    ])

    expect(artifacts).toEqual([
      {
        path: 'docs/plans/build.md',
        fileName: 'build.md',
        href: 'docs/plans/build.md',
        title: 'Build Plan',
        sourceAgentId: 'manager',
      },
    ])
  })

  it('normalizes one leading slash from common malformed Windows Markdown destinations', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('[Report](/T:/repos/project/report.md)', 'windows-report'),
    ], 'viewed-manager')

    expect(artifacts).toEqual([
      {
        path: 'T:/repos/project/report.md',
        fileName: 'report.md',
        href: '/T:/repos/project/report.md',
        title: 'Report',
        sourceAgentId: 'manager',
        transcriptAgentId: 'viewed-manager',
        messageId: 'windows-report',
      },
    ])
  })

  it('normalizes Windows artifact shortcodes and preserves source agent context', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('[artifact:C:/Users/example/project/README.md]'),
    ])

    expect(artifacts).toEqual([
      {
        path: 'C:/Users/example/project/README.md',
        fileName: 'README.md',
        href: 'swarm-file:///C:/Users/example/project/README.md',
        sourceAgentId: 'manager',
      },
    ])
  })

  it('uses the viewed transcript owner rather than the actor agent for secure provenance', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('[artifact:/tmp/result.png]', 'message-7', 'actor-worker'),
    ], 'viewed-manager')

    expect(artifacts).toEqual([
      {
        path: '/tmp/result.png',
        fileName: 'result.png',
        href: 'swarm-file:///tmp/result.png',
        sourceAgentId: 'actor-worker',
        transcriptAgentId: 'viewed-manager',
        messageId: 'message-7',
      },
    ])
  })

  it('collects artifact links from worker messages without inventing transcript provenance', () => {
    const artifacts = collectArtifactsFromMessages([
      agentMessage('Exported [artifact:/tmp/session/artifacts/report.json]'),
    ], 'viewed-manager')

    expect(artifacts).toEqual([
      {
        path: '/tmp/session/artifacts/report.json',
        fileName: 'report.json',
        href: 'swarm-file:///tmp/session/artifacts/report.json',
        sourceAgentId: 'worker-1',
      },
    ])
  })

  it('ignores placeholder artifact examples in prose', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage([
        'Examples should not populate artifacts:',
        '[artifact:<path>]',
        '[artifact:/...]',
        'swarm-file://...',
        'vscode://file/...',
        'Use `/...` only as a placeholder.',
      ].join('\n')),
    ])

    expect(artifacts).toEqual([])
  })

  it('ignores artifact examples inside inline and fenced code', () => {
    const artifacts = collectArtifactsFromMessages([
      agentMessage([
        'Inline example: `[artifact:/tmp/session/artifacts/example.json]`.',
        '```md',
        '[artifact:/tmp/session/artifacts/fenced.json]',
        'swarm-file:///tmp/session/artifacts/fenced.json',
        '```',
      ].join('\n')),
    ])

    expect(artifacts).toEqual([])
  })

  it('ignores escaped shortcodes and indented CommonMark code blocks', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage([
        '\\[artifact:/tmp/escaped.json]',
        '',
        '    [artifact:/tmp/indented.json]',
      ].join('\n'), 'assistant-code-1'),
    ], 'viewed-manager')

    expect(artifacts).toEqual([])
  })

  it('preserves eligible transcript provenance across duplicate worker references in both orders', () => {
    const assistant = assistantMessage('[artifact:/tmp/shared.png]', 'assistant-shared', 'actor-worker')
    const worker = agentMessage('[artifact:/tmp/shared.png]')

    for (const messages of [[assistant, worker], [worker, assistant]]) {
      const artifacts = collectArtifactsFromMessages(messages, 'viewed-manager')
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        path: '/tmp/shared.png',
        transcriptAgentId: 'viewed-manager',
        messageId: 'assistant-shared',
      })
    }
  })

  it('ignores artifact examples inside unclosed fenced code through EOF', () => {
    const artifacts = collectArtifactsFromMessages([
      agentMessage([
        'Here is an example:',
        '```md',
        '[artifact:/tmp/fenced.json]',
      ].join('\n')),
    ])

    expect(artifacts).toEqual([])
  })

  it('handles CRLF closed fences without dropping artifacts after the fence', () => {
    const artifacts = collectArtifactsFromMessages([
      agentMessage('```md\r\n[artifact:/tmp/inside.json]\r\n```\r\nExported [artifact:/tmp/outside.json]'),
    ])

    expect(artifacts).toEqual([
      {
        path: '/tmp/outside.json',
        fileName: 'outside.json',
        href: 'swarm-file:///tmp/outside.json',
        sourceAgentId: 'worker-1',
      },
    ])
  })

  it('keeps real absolute artifact shortcodes in normal assistant text', () => {
    const artifacts = collectArtifactsFromMessages([
      assistantMessage('Exported [artifact:/tmp/session/artifacts/real-report.json]'),
    ])

    expect(artifacts).toEqual([
      {
        path: '/tmp/session/artifacts/real-report.json',
        fileName: 'real-report.json',
        href: 'swarm-file:///tmp/session/artifacts/real-report.json',
        sourceAgentId: 'manager',
      },
    ])
  })

  it('collects Codex Plugin export artifact links only from explicit tool result fields', () => {
    const artifacts = collectArtifactsFromMessages([
      agentToolCallEnd(JSON.stringify({
        absolutePath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json',
        manifestPath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json',
        artifactMarkdown: '[artifact:/tmp/session/artifacts/codex-plugin/delegation/transcript.json]',
        manifestMarkdown: '[artifact:/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json]',
        preview: 'Ignored preview with [artifact:/fake/from-preview.md]',
      })),
    ], 'viewed-manager')

    expect(artifacts).toEqual([
      {
        path: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json',
        fileName: 'transcript.json',
        href: 'swarm-file:///tmp/session/artifacts/codex-plugin/delegation/transcript.json',
        sourceAgentId: 'codex-plugin-fireflies',
      },
      {
        path: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json',
        fileName: 'transcript.json.manifest.json',
        href: 'swarm-file:///tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json',
        sourceAgentId: 'codex-plugin-fireflies',
      },
    ])
  })

  it('ignores Codex Plugin export preview text that looks like an artifact link', () => {
    const artifacts = collectArtifactsFromMessages([
      agentToolCallEnd(JSON.stringify({
        absolutePath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json',
        manifestPath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json',
        preview: 'Do not collect [artifact:/fake/from-preview.md] or [Fake](tmp/fake-from-preview.md)',
      })),
    ])

    expect(artifacts).toEqual([])
  })

  it('ignores unrelated tool output that contains artifact-like text', () => {
    const artifacts = collectArtifactsFromMessages([
      agentToolCallEnd(
        'Tool output with [artifact:/fake/from-other-tool.md] and [Fake](tmp/fake-from-other-tool.md)',
        'read',
      ),
    ])

    expect(artifacts).toEqual([])
  })
})

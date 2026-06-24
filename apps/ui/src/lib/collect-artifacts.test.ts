import { describe, expect, it } from 'vitest'
import { collectArtifactsFromMessages } from './collect-artifacts'
import type { ConversationEntry } from '@forge/protocol'

function assistantMessage(text: string): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'manager',
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

function agentToolCallEnd(text: string): ConversationEntry {
  return {
    type: 'agent_tool_call',
    agentId: 'manager',
    actorAgentId: 'codex-plugin-fireflies',
    kind: 'tool_execution_end',
    toolName: 'export_scoped_codex_plugin_result',
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

  it('collects artifact links from worker messages', () => {
    const artifacts = collectArtifactsFromMessages([
      agentMessage('Exported [artifact:/tmp/session/artifacts/report.json]'),
    ])

    expect(artifacts).toEqual([
      {
        path: '/tmp/session/artifacts/report.json',
        fileName: 'report.json',
        href: 'swarm-file:///tmp/session/artifacts/report.json',
        sourceAgentId: 'worker-1',
      },
    ])
  })

  it('collects Codex Plugin export artifact links from tool results without parsing raw paths', () => {
    const artifacts = collectArtifactsFromMessages([
      agentToolCallEnd(JSON.stringify({
        absolutePath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json',
        manifestPath: '/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json',
        artifactMarkdown: '[artifact:/tmp/session/artifacts/codex-plugin/delegation/transcript.json]',
        manifestMarkdown: '[artifact:/tmp/session/artifacts/codex-plugin/delegation/transcript.json.manifest.json]',
      })),
    ])

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
})

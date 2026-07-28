import { describe, expect, it } from 'vitest'
import {
  acceptWorkGraphNodeToolSchema,
  buildAcceptWorkGraphNodeTool,
  normalizeAcceptWorkGraphNodeInput,
} from '../planning/accept-work-graph-node-tool.js'

describe('accept_work_graph_node guidance', () => {
  it('requires one stable node id and bounded manager evidence', () => {
    const serialized = JSON.stringify(acceptWorkGraphNodeToolSchema)

    expect(serialized).toContain('Stable id of the awaiting_review node')
    expect(serialized).toContain('manager acceptance check')
    expect(serialized).toContain('worker completion claim alone is not sufficient')
  })

  it('teaches a targeted acceptance transition without broad graph mutation', () => {
    const tool = buildAcceptWorkGraphNodeTool({} as never, {} as never)

    expect(tool.description).toContain('smallest check')
    expect(tool.description).toContain('changes only that node')
    expect(tool.description).toContain('newly ready dependents')
    expect(tool.description).toContain('Do not use this tool to revise graph topology')
  })

  it('executes through the host bridge and preserves the wire envelope', async () => {
    const host = {
      acceptWorkGraphNode: async (...args: unknown[]) => ({
        acceptedNodeId: "research",
        alreadyAccepted: false,
        status: "updated",
        node: { id: "research", status: "completed" },
        readyNodeIds: ["implement"],
        args,
      }),
    };
    const tool = buildAcceptWorkGraphNodeTool(host as never, { agentId: "manager-1" } as never);
    const result = await tool.execute("tool-7", { nodeId: " research ", evidence: " verified " });
    expect(host.acceptWorkGraphNode).toBeDefined();
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining('"acceptedNodeId":"research"') }]);
    expect(result.details).toMatchObject({ acceptedNodeId: "research", readyNodeIds: ["implement"] });
    expect((result.details as { args: unknown[] }).args).toEqual([
      "manager-1",
      "tool-7",
      { nodeId: " research ", evidence: " verified " },
    ]);
  });

  it('normalizes evidence and rejects invalid targeted input', () => {
    expect(normalizeAcceptWorkGraphNodeInput({
      nodeId: 'research',
      evidence: '  Verified the cited source path.  ',
    })).toEqual({
      nodeId: 'research',
      evidence: 'Verified the cited source path.',
    })
    expect(() => normalizeAcceptWorkGraphNodeInput({
      nodeId: 'Research',
      evidence: 'Verified.',
    })).toThrow('valid stable work-graph node id')
    expect(() => normalizeAcceptWorkGraphNodeInput({
      nodeId: 'research',
      evidence: '   ',
    })).toThrow('evidence must contain')
  })
})

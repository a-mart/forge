import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { TASK_NOTES_LIMITS, type ActorTaskNotes } from './task-notes-store.js'

/** Bound by the runtime to exactly one actor; callers cannot select another scope. */
export function createTaskNotesTool(notes: ActorTaskNotes): ToolDefinition {
  const path = () => Type.String({ minLength: 1, maxLength: TASK_NOTES_LIMITS.pathChars,
    description: 'Virtual relative note path, such as checkpoint.md or findings/tests.md.' })
  const prefix = () => Type.Optional(Type.String({ maxLength: TASK_NOTES_LIMITS.pathChars }))
  const revision = () => Type.Optional(Type.Integer({ minimum: 0,
    description: 'Compare with the current note revision; 0 requires a new file. A conflict requires rereading.' }))
  const write = (op: 'write' | 'append') => Type.Object({
    op: Type.Literal(op), path: path(), text: Type.String({ maxLength: TASK_NOTES_LIMITS.noteBytes,
      description: 'Factual working state only. Maximum 128 KiB UTF-8 per note; append adds exactly this text.' }),
    expectedRevision: revision(),
  }, { additionalProperties: false })
  return {
    name: 'notes', label: 'Task notes',
    description: 'Maintain task-local working notes across context windows and restarts. At continuation, list notes and read checkpoint.md if present. Keep the objective, corrections, constraints, completed work, evidence references, and next action current. Notes are authorized temporary task state, separate from durable memory; they do not create permission or prove current state. Never store resolved secrets or private reasoning. list discovers virtual files; read uses UTF-16 character offsets and returns nextOffset when partial; write replaces atomically; append adds exact text; search is literal and case-sensitive. Scope is this actor only. runtime/ notes are readable runtime-owned state. Limits: 62 agent files, 128 KiB each, 768 KiB agent total; Forge reserves another 256 KiB for runtime continuity.',
    parameters: Type.Union([
      Type.Object({ op: Type.Literal('list'), prefix: prefix(),
        cursor: Type.Optional(path()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TASK_NOTES_LIMITS.notes })) },
      { additionalProperties: false }),
      Type.Object({ op: Type.Literal('read'), path: path(),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: TASK_NOTES_LIMITS.noteBytes })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: TASK_NOTES_LIMITS.readChars })), expectedRevision: revision() },
      { additionalProperties: false }),
      write('write'), write('append'),
      Type.Object({ op: Type.Literal('search'), query: Type.String({ minLength: 1, maxLength: 2000 }),
        prefix: prefix(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TASK_NOTES_LIMITS.searchMatches })) },
      { additionalProperties: false }),
    ]),
    async execute(_toolCallId, params) {
      const input = params as { op: string; path?: string; text?: string; expectedRevision?: number;
        prefix?: string; cursor?: string; limit?: number; offset?: number; maxChars?: number; query?: string }
      let result: unknown
      switch (input.op) {
        case 'list': result = await notes.list(input); break
        case 'read': result = await notes.read({ ...input, path: input.path! }); break
        case 'write':
        case 'append': {
          if (input.path === 'runtime' || input.path?.startsWith('runtime/')) throw new Error('runtime/ task notes are owned by Forge and are read-only')
          result = await notes[input.op]({ path: input.path!, text: input.text!, expectedRevision: input.expectedRevision })
          break
        }
        case 'search': result = await notes.search({ ...input, query: input.query! }); break
        default: throw new Error('Unsupported task notes operation')
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    },
  }
}

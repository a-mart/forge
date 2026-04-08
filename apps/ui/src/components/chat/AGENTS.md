# Local context for `apps/ui/src/components/chat`

Keep changes here aligned with the existing component split. The chat surface is built as a stable facade with focused submodules, so prefer small edits inside the relevant leaf file instead of folding logic back into the top-level component.

## AgentSidebar

`AgentSidebar.tsx` is the public entry point. Its external prop interface is stable, so do not change `AgentSidebarProps` unless every caller is updated in the same change.

Decomposition lives in:
- `agent-sidebar/` for leaf UI pieces and helpers
- `agent-sidebar/hooks/` for state and derived behavior
- `agent-sidebar/dialogs/` for modal flows
- `project-agent/` for project-agent specific UI

Keep hooks single-purpose. If a hook only handles search state, drag state, sidebar prefs, or cortex badge logic, keep it isolated instead of merging responsibilities.

Do not import `ws-client` directly from sidebar components. Transport and socket state should come in through props or context.

Key tests:
- `apps/ui/src/components/chat/AgentSidebar.test.ts`
- `apps/ui/src/components/chat/ChangeCwdDialog.test.ts`

## MessageInput

`MessageInput.tsx` is also a stable facade. Its external prop interface is shared by multiple callers, so changes to `MessageInputProps` or `MessageInputHandle` need a full consumer check.

Decomposition lives in:
- `message-input/` for menus, composer, formatting, and draft helpers
- `message-input/hooks/` for draft, slash commands, mentions, voice input, attachments, and composer state

Keep each hook narrowly scoped. Draft persistence, mention handling, slash commands, voice input, attachments, and composer behavior should remain separate concerns.

Do not import `ws-client` directly from message input code. Use props or context for transport details such as `wsUrl`.

Key tests:
- `apps/ui/src/components/chat/MessageInput.test.ts`

## General

When adding new chat submodules, keep the top-level component as the compatibility layer and place new implementation detail under the closest existing subdirectory.
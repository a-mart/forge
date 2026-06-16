import type { FileEditorTransitionAction } from '@/components/file-browser/use-file-editor-coordinator'

export interface FileEditorTransitionRequester {
  requestFileEditorTransition: (action: FileEditorTransitionAction, run: () => void) => void
}

export function requestGuardedArtifactsPanelToggle(
  requester: FileEditorTransitionRequester,
  run: () => void,
): void {
  requester.requestFileEditorTransition({ type: 'open-workspace-panel', panel: 'artifacts' }, run)
}

export function requestGuardedAgentTransition(
  requester: FileEditorTransitionRequester,
  nextAgentId: string,
  run: () => void,
): void {
  requester.requestFileEditorTransition({ type: 'select-agent', nextAgentId }, run)
}

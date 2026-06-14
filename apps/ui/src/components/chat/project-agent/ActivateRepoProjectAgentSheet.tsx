import { useMemo } from 'react'
import type { RepoProjectAgentInventoryItem } from '@forge/protocol'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'
import {
  ProjectAgentDefinitionRow,
  RepoProjectAgentActivationHeader,
  useRepoProjectAgentActivation,
} from '@/components/settings/repo-project-agent-ui'

export interface ActivateRepoProjectAgentSheetProps {
  wsUrl: string
  profileId: string
  sessionAgentId: string
  item: RepoProjectAgentInventoryItem
  onClose: () => void
  onActivated?: (agentId: string) => void
}

export function ActivateRepoProjectAgentSheet({
  wsUrl,
  profileId,
  sessionAgentId,
  item,
  onClose,
  onActivated,
}: ActivateRepoProjectAgentSheetProps) {
  const apiClient = useMemo(() => createBuilderSettingsApiClient(wsUrl), [wsUrl])
  const context = useMemo(() => ({ profileId, sessionAgentId }), [profileId, sessionAgentId])
  const {
    activatingId,
    activateError,
    handleActivate,
  } = useRepoProjectAgentActivation({
    apiClient,
    context,
    onActivated: (agentId) => {
      onActivated?.(agentId)
      onClose()
    },
  })

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle><RepoProjectAgentActivationHeader /></SheetTitle>
          <SheetDescription>
            Activate this repository project agent definition to create a live project agent session in this project.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {activateError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
              {activateError}
            </div>
          ) : null}
          <ProjectAgentDefinitionRow
            item={item}
            activating={activatingId === item.definitionId}
            onActivate={item.status === 'valid' && !item.activatedAgentId
              ? () => { void handleActivate(item) }
              : undefined}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

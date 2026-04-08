import type { ComponentPropsWithoutRef } from 'react'
import { ArtifactPanel } from '@/components/chat/ArtifactPanel'
import { CreateManagerDialog } from '@/components/chat/CreateManagerDialog'
import { DeleteManagerDialog } from '@/components/chat/DeleteManagerDialog'
import { ForkSessionDialog } from '@/components/chat/ForkSessionDialog'
import { DiffViewerDialog } from '@/components/diff-viewer/DiffViewerDialog'

interface GlobalDialogsProps {
  artifactPanelProps: ComponentPropsWithoutRef<typeof ArtifactPanel>
  createManagerDialogProps: ComponentPropsWithoutRef<typeof CreateManagerDialog>
  deleteManagerDialogProps: ComponentPropsWithoutRef<typeof DeleteManagerDialog>
  forkSessionDialogProps?: ComponentPropsWithoutRef<typeof ForkSessionDialog> | null
  diffViewerDialogProps: ComponentPropsWithoutRef<typeof DiffViewerDialog>
}

export function GlobalDialogs({
  artifactPanelProps,
  createManagerDialogProps,
  deleteManagerDialogProps,
  forkSessionDialogProps,
  diffViewerDialogProps,
}: GlobalDialogsProps) {
  return (
    <>
      <ArtifactPanel {...artifactPanelProps} />
      <CreateManagerDialog {...createManagerDialogProps} />
      <DeleteManagerDialog {...deleteManagerDialogProps} />
      {forkSessionDialogProps ? <ForkSessionDialog {...forkSessionDialogProps} /> : null}
      <DiffViewerDialog {...diffViewerDialogProps} />
    </>
  )
}

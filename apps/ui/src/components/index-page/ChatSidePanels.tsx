import type { ComponentPropsWithoutRef } from 'react'
import { ArtifactsSidebar } from '@/components/chat/ArtifactsSidebar'
import { CortexDashboardPanel } from '@/components/chat/cortex/CortexDashboardPanel'
import { FileBrowserSidebar } from '@/components/file-browser/FileBrowserSidebar'
import { FileBrowserPanel } from '@/components/file-browser/FileBrowserPanel'

interface ChatSidePanelsProps {
  isCortexSession: boolean
  cortexDashboardProps: ComponentPropsWithoutRef<typeof CortexDashboardPanel>
  artifactsSidebarProps: ComponentPropsWithoutRef<typeof ArtifactsSidebar>
  fileBrowserSidebarProps: ComponentPropsWithoutRef<typeof FileBrowserSidebar>
  fileBrowserPanelProps?: ComponentPropsWithoutRef<typeof FileBrowserPanel> | null
}

export function ChatSidePanels({
  isCortexSession,
  cortexDashboardProps,
  artifactsSidebarProps,
  fileBrowserSidebarProps,
  fileBrowserPanelProps,
}: ChatSidePanelsProps) {
  return (
    <>
      {isCortexSession ? (
        <CortexDashboardPanel {...cortexDashboardProps} />
      ) : (
        <ArtifactsSidebar {...artifactsSidebarProps} />
      )}
      {fileBrowserPanelProps ? <FileBrowserPanel {...fileBrowserPanelProps} /> : null}
      <FileBrowserSidebar {...fileBrowserSidebarProps} />
    </>
  )
}

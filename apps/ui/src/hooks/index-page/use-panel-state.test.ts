/** @vitest-environment jsdom */

import { createElement, useState, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePanelState } from './use-panel-state'

// Capture the hook's return value from within a component
type PanelStateReturn = ReturnType<typeof usePanelState>

let container: HTMLDivElement
let root: Root | null = null
const capturedRef: {
  current: {
    panelState: PanelStateReturn
    setAgentId: (id: string | null) => void
    setArchetypeId: (id: string | null | undefined) => void
  } | null
} = { current: null }

function PanelStateHarness() {
  const [activeAgentId, setActiveAgentId] = useState<string | null>('agent-1')
  const [activeAgentArchetypeId, setActiveAgentArchetypeId] = useState<string | null | undefined>(
    null,
  )

  const panelState = usePanelState({ activeAgentId, activeAgentArchetypeId })

  const setAgentId = useCallback((id: string | null) => setActiveAgentId(id), [])
  const setArchetypeId = useCallback(
    (id: string | null | undefined) => setActiveAgentArchetypeId(id),
    [],
  )

  useEffect(() => {
    capturedRef.current = { panelState, setAgentId, setArchetypeId }
  })

  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  capturedRef.current = null
  container.remove()
})

function render() {
  act(() => {
    root = createRoot(container)
    root.render(createElement(PanelStateHarness))
  })
}

describe('usePanelState', () => {
  describe('agent switch closes artifact/file/mobile panels', () => {
    it('closes artifacts panel on agent switch', () => {
      render()

      // Open artifacts panel
      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel()
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)

      // Switch agent — useEffect runs to close panels
      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
    })

    it('closes file browser on agent switch', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)

      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
    })

    it('clears active artifact on agent switch', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.openArtifact({
          path: '/tmp/test.ts',
          fileName: 'test.ts',
          href: 'swarm-file:///tmp/test.ts',
        })
      })
      expect(capturedRef.current!.panelState.activeArtifact).not.toBeNull()

      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })
      expect(capturedRef.current!.panelState.activeArtifact).toBeNull()
    })

    it('closes mobile sidebar on agent switch', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.setIsMobileSidebarOpen(true)
      })
      expect(capturedRef.current!.panelState.isMobileSidebarOpen).toBe(true)

      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })
      expect(capturedRef.current!.panelState.isMobileSidebarOpen).toBe(false)
    })

    it('clears selected file browser file on agent switch', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      act(() => {
        capturedRef.current!.panelState.selectFileBrowserFile('/path/to/file.ts')
      })
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/path/to/file.ts')

      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBeNull()
    })
  })

  describe('Cortex pending-open only opens for Cortex', () => {
    it('opens artifacts panel when cortex dashboard tab is requested and archetype becomes cortex', () => {
      render()

      // Request cortex dashboard tab — sets pendingCortexDashboardOpen
      act(() => {
        capturedRef.current!.panelState.requestCortexDashboardTab('index')
      })
      // Panel should not open yet because archetype is not cortex
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)

      // Set archetype to cortex — useEffect opens the panel
      act(() => {
        capturedRef.current!.setArchetypeId('cortex')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
    })

    it('does not open artifacts panel for non-cortex archetype even with pending request', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.requestCortexDashboardTab('index')
      })

      act(() => {
        capturedRef.current!.setArchetypeId('default')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
    })

    it('cortex dashboard tab request sets nonce and tab', () => {
      render()

      expect(capturedRef.current!.panelState.cortexDashboardTabRequest).toBeNull()

      act(() => {
        capturedRef.current!.panelState.requestCortexDashboardTab('index')
      })

      expect(capturedRef.current!.panelState.cortexDashboardTabRequest).not.toBeNull()
      expect(capturedRef.current!.panelState.cortexDashboardTabRequest!.tab).toBe('index')
      expect(typeof capturedRef.current!.panelState.cortexDashboardTabRequest!.nonce).toBe('number')
    })

    it('requesting cortex dashboard tab hides file browser and preserves selected file', () => {
      render()

      act(() => {
        capturedRef.current!.setArchetypeId('cortex')
      })
      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      act(() => {
        capturedRef.current!.panelState.selectFileBrowserFile('/tmp/example.ts')
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/tmp/example.ts')

      act(() => {
        capturedRef.current!.panelState.requestCortexDashboardTab('consolidation')
      })

      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/tmp/example.ts')
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
    })

    it('toggleCortexDashboardTab closes file browser when opening from rail', () => {
      render()

      act(() => {
        capturedRef.current!.setArchetypeId('cortex')
      })
      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.toggleCortexDashboardTab('index')
      })

      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBeNull()
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
    })
  })

  describe('keyboard shortcuts ignore form fields where applicable', () => {
    it('Ctrl+Shift+D toggles diff viewer', () => {
      render()
      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(false)

      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'D',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
        window.dispatchEvent(event)
      })

      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(true)
    })

    it('Ctrl+Shift+E toggles file browser from a non-form-field target', () => {
      render()
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)

      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
        window.dispatchEvent(event)
      })

      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)
    })

    it('Ctrl+Shift+E is ignored when target is an INPUT element', () => {
      render()
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)

      const input = document.createElement('input')
      document.body.appendChild(input)

      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
        Object.defineProperty(event, 'target', { value: input, writable: false })
        window.dispatchEvent(event)
      })

      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)

      input.remove()
    })

    it('Ctrl+Shift+E is ignored when target is a TEXTAREA element', () => {
      render()
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)

      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'E',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
        Object.defineProperty(event, 'target', { value: textarea, writable: false })
        window.dispatchEvent(event)
      })

      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)

      textarea.remove()
    })

    it('Ctrl+Shift+D is ignored when target is an INPUT element', () => {
      render()
      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(false)

      const input = document.createElement('input')
      document.body.appendChild(input)

      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'D',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
        Object.defineProperty(event, 'target', { value: input, writable: false })
        window.dispatchEvent(event)
      })

      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(false)

      input.remove()
    })
  })

  describe('panel mutual exclusivity', () => {
    it('opening artifacts panel closes file browser', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel()
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
    })

    it('opening file browser closes artifacts panel', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel()
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
    })

    it('explicitly opening file browser is idempotent and closes artifacts panel', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('schedules')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.openFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)

      act(() => {
        capturedRef.current!.panelState.openFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)
    })

    it('closing workspace panels returns to chat primary surface without touching diff state', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('artifacts')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.closeWorkspacePanels()
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
    })

    it('opening schedules tab closes file browser', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('schedules')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
      expect(capturedRef.current!.panelState.artifactsPanelTab).toBe('schedules')
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
    })

    it('toggling the same artifacts tab closes the panel', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('artifacts')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('artifacts')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
    })

    it('switching from artifacts to schedules keeps the panel open', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('artifacts')
      })
      expect(capturedRef.current!.panelState.artifactsPanelTab).toBe('artifacts')

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('schedules')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
      expect(capturedRef.current!.panelState.artifactsPanelTab).toBe('schedules')
    })

    it('toggle without tab closes panel regardless of active tab', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel('schedules')
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(true)
      expect(capturedRef.current!.panelState.artifactsPanelTab).toBe('schedules')

      act(() => {
        capturedRef.current!.panelState.toggleArtifactsPanel()
      })
      expect(capturedRef.current!.panelState.isArtifactsPanelOpen).toBe(false)
    })

    it('closing file browser hides it and preserves selected file', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      act(() => {
        capturedRef.current!.panelState.selectFileBrowserFile('/path/to/file.ts')
      })
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/path/to/file.ts')

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      expect(capturedRef.current!.panelState.isFileBrowserOpen).toBe(false)
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/path/to/file.ts')
    })
  })

  describe('utility callbacks', () => {
    it('openDiffViewer sets initial state and opens', () => {
      render()

      const initialState = {
        initialTab: 'changes' as const,
        initialSha: 'abc123',
      }

      act(() => {
        capturedRef.current!.panelState.openDiffViewer(initialState)
      })
      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(true)
      expect(capturedRef.current!.panelState.diffViewerInitialState).toEqual(initialState)
    })

    it('openDiffViewer with null initial state', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.openDiffViewer(null)
      })
      expect(capturedRef.current!.panelState.isDiffViewerOpen).toBe(true)
      expect(capturedRef.current!.panelState.diffViewerInitialState).toBeNull()
    })

    it('openArtifact / closeArtifact manage activeArtifact', () => {
      render()

      const artifact = {
        path: '/tmp/example.ts',
        fileName: 'example.ts',
        href: 'swarm-file:///tmp/example.ts',
      }

      act(() => {
        capturedRef.current!.panelState.openArtifact(artifact)
      })
      expect(capturedRef.current!.panelState.activeArtifact).toEqual(artifact)

      act(() => {
        capturedRef.current!.panelState.closeArtifact()
      })
      expect(capturedRef.current!.panelState.activeArtifact).toBeNull()
    })

    it('navigateFileBrowserToDirectory clears selected file', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.toggleFileBrowser()
      })
      act(() => {
        capturedRef.current!.panelState.selectFileBrowserFile('/path/to/file.ts')
      })
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('/path/to/file.ts')

      act(() => {
        capturedRef.current!.panelState.navigateFileBrowserToDirectory('/path/to')
      })
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBeNull()
    })

    it('clearFileBrowserWorktreeContext switches back to session file scope', () => {
      render()

      act(() => {
        capturedRef.current!.panelState.browseWorktreeFiles({
          worktreeId: 'feature-linked',
          worktreePath: '/repo/middleman-feature',
          branch: 'feature/worktree-test',
          repoRoot: '/repo/middleman',
        })
      })
      act(() => {
        capturedRef.current!.panelState.selectFileBrowserFile('linked-only.txt')
      })
      expect(capturedRef.current!.panelState.fileBrowserWorktreeContext?.worktreeId).toBe('feature-linked')
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBe('linked-only.txt')

      act(() => {
        capturedRef.current!.panelState.clearFileBrowserWorktreeContext()
      })
      expect(capturedRef.current!.panelState.fileBrowserWorktreeContext).toBeNull()
      expect(capturedRef.current!.panelState.selectedFileBrowserFile).toBeNull()
    })
  })
})

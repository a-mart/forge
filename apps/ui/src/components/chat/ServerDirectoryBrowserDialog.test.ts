/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const { ServerDirectoryBrowserDialog } = await import('./ServerDirectoryBrowserDialog')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
    root = null
  })
  container.remove()
  document.body.innerHTML = ''
})

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]')
}

describe('ServerDirectoryBrowserDialog', () => {
  it('lists roots, creates a folder when capable, and selects a path', async () => {
    const listDirectories = vi.fn(async (path?: string) => {
      if (!path) {
        return {
          path: '/workspaces',
          directories: ['/workspaces'],
          resolvedPath: '/workspaces',
          parentPath: null,
          roots: ['/workspaces'],
          entries: [{ name: 'workspaces', path: '/workspaces' }],
        }
      }
      return {
        path,
        directories: path === '/workspaces' ? ['/workspaces/demo'] : [],
        resolvedPath: path,
        parentPath: path === '/workspaces' ? null : '/workspaces',
        roots: ['/workspaces'],
        entries:
          path === '/workspaces'
            ? [{ name: 'demo', path: '/workspaces/demo' }]
            : [],
      }
    })
    const validateDirectory = vi.fn(async (path: string) => ({
      path,
      valid: true,
      message: null,
      resolvedPath: path,
      roots: ['/workspaces'],
    }))
    const createDirectory = vi.fn(async (parentPath: string, name: string) => ({
      path: `${parentPath}/${name}`,
      parentPath,
      name,
      roots: ['/workspaces'],
    }))
    const onSelect = vi.fn()

    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(ServerDirectoryBrowserDialog, {
          open: true,
          onOpenChange: () => {},
          client: { listDirectories, validateDirectory, createDirectory },
          canCreateDirectory: true,
          onSelect,
        }),
      )
    })

    await waitFor(() => {
      expect(listDirectories).toHaveBeenCalled()
      expect(dialog()?.textContent).toContain('Allowed roots')
      expect(dialog()?.textContent).toContain('/workspaces')
    })

    const newFolderButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New folder'),
    )
    expect(newFolderButton).toBeTruthy()
    await act(async () => {
      fireEvent.click(newFolderButton!)
    })

    const nameInput = await waitFor(() => {
      const input = document.body.querySelector('input[aria-label="New folder name"]') as HTMLInputElement | null
      expect(input).toBeTruthy()
      return input!
    })

    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'demo' } })
    })
    expect(nameInput.value).toBe('demo')

    const createButton = await waitFor(() => {
      const button = Array.from(document.body.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === 'Create',
      ) as HTMLButtonElement | undefined
      expect(button).toBeTruthy()
      expect(button!.disabled).toBe(false)
      return button!
    })

    await act(async () => {
      fireEvent.click(createButton)
    })

    await waitFor(() => {
      expect(createDirectory).toHaveBeenCalledWith('/workspaces', 'demo')
    })

    const useButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Use this folder'),
    )
    expect(useButton).toBeTruthy()
    await act(async () => {
      fireEvent.click(useButton!)
    })
    await waitFor(() => {
      expect(validateDirectory).toHaveBeenCalled()
      expect(onSelect).toHaveBeenCalled()
    })
  })

  it('falls back to allowed roots when the initial cwd is outside the server allowlist', async () => {
    const listDirectories = vi.fn(async (path?: string) => {
      if (path === '/app') throw new Error('LIST_DIRECTORIES_FAILED: Directory is outside the configured workspace roots.')
      return {
        path: '/workspaces',
        directories: ['/workspaces'],
        resolvedPath: '/workspaces',
        parentPath: null,
        roots: ['/workspaces'],
        entries: [{ name: 'workspaces', path: '/workspaces' }],
      }
    })

    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(ServerDirectoryBrowserDialog, {
          open: true,
          initialPath: '/app',
          onOpenChange: () => {},
          client: {
            listDirectories,
            validateDirectory: async (path) => ({ path, valid: true, message: null, resolvedPath: path }),
          },
          onSelect: () => {},
        }),
      )
    })

    await waitFor(() => {
      expect(listDirectories).toHaveBeenNthCalledWith(1, '/app')
      expect(listDirectories).toHaveBeenNthCalledWith(2)
      expect(dialog()?.textContent).toContain('/workspaces')
    })
  })

  it('keeps non-policy initial-path errors visible instead of falling back to roots', async () => {
    const listDirectories = vi.fn(async () => {
      throw new Error('DIRECTORY_LIST_FAILED: permission denied')
    })

    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(ServerDirectoryBrowserDialog, {
          open: true,
          initialPath: '/app',
          onOpenChange: () => {},
          client: {
            listDirectories,
            validateDirectory: async (path) => ({ path, valid: false, message: 'denied' }),
          },
          onSelect: () => {},
        }),
      )
    })

    await waitFor(() => {
      expect(dialog()?.textContent).toContain('DIRECTORY_LIST_FAILED: permission denied')
    })
    expect(listDirectories).toHaveBeenCalledTimes(1)
  })

  it('hides New folder when createDirectory capability is absent', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(ServerDirectoryBrowserDialog, {
          open: true,
          onOpenChange: () => {},
          client: {
            listDirectories: async () => ({
              path: '/workspaces',
              directories: [],
              resolvedPath: '/workspaces',
              roots: ['/workspaces'],
              entries: [],
            }),
            validateDirectory: async (path) => ({ path, valid: true, message: null, resolvedPath: path }),
          },
          canCreateDirectory: false,
          onSelect: () => {},
        }),
      )
    })

    await waitFor(() => {
      expect(dialog()?.textContent).toContain('Allowed roots')
    })
    expect(dialog()?.textContent).not.toContain('New folder')
  })

  it('surfaces admin mount guidance when no roots are configured', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        createElement(ServerDirectoryBrowserDialog, {
          open: true,
          onOpenChange: () => {},
          client: {
            listDirectories: async () => {
              throw new Error('No usable workspace roots are configured. An admin must set FORGE_CWD_ALLOWLIST_ROOTS and mount a workspace root.')
            },
            validateDirectory: async (path) => ({ path, valid: false, message: 'denied' }),
          },
          onSelect: () => {},
        }),
      )
    })

    await waitFor(() => {
      expect(dialog()?.textContent).toMatch(/admin needs to mount/i)
    })
  })
})

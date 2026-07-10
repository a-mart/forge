import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLatestRef } from '@/hooks/useLatestRef'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertCircle,
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import type {
  DirectoriesListedResult,
  DirectoryCreatedResult,
  DirectoryValidationResult,
} from '@/lib/ws-client'

export interface ServerDirectoryBrowserClient {
  listDirectories: (path?: string) => Promise<DirectoriesListedResult>
  validateDirectory: (path: string) => Promise<DirectoryValidationResult>
  createDirectory?: (parentPath: string, name: string) => Promise<DirectoryCreatedResult>
}

interface ServerDirectoryBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: ServerDirectoryBrowserClient
  /** When false/undefined, hide "+ New folder" (older servers). */
  canCreateDirectory?: boolean
  initialPath?: string
  title?: string
  description?: string
  onSelect: (path: string) => void
}

type BrowserEntry = { name: string; path: string }

function isOutsideAllowedRootsError(message: string): boolean {
  return message.includes('DIRECTORY_OUTSIDE_ROOT') || /outside the configured workspace roots/i.test(message)
}

export function ServerDirectoryBrowserDialog({
  open,
  onOpenChange,
  client,
  canCreateDirectory = false,
  initialPath,
  title = 'Browse server folders',
  description = 'Choose a working directory on this remote Forge instance.',
  onSelect,
}: ServerDirectoryBrowserDialogProps) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath?.trim() || undefined)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  const [entries, setEntries] = useState<BrowserEntry[]>([])
  const [pathInput, setPathInput] = useState(initialPath?.trim() ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [selecting, setSelecting] = useState(false)
  // Parent origin/status updates can replace the client object while this dialog
  // is open. Keep requests on the latest client without making the open effect
  // depend on its identity.
  const clientRef = useLatestRef(client)
  const initialPathRef = useLatestRef(initialPath)
  const onOpenChangeRef = useLatestRef(onOpenChange)
  const onSelectRef = useLatestRef(onSelect)

  const applyListing = useCallback((listed: DirectoriesListedResult) => {
    const nextPath = listed.resolvedPath ?? listed.path
    setCurrentPath(nextPath)
    setParentPath(listed.parentPath ?? null)
    setRoots(listed.roots ?? [])
    const nextEntries =
      listed.entries && listed.entries.length > 0
        ? listed.entries
        : (listed.directories ?? []).map((entryPath) => ({
            name: entryPath.split(/[/\\]/).filter(Boolean).at(-1) ?? entryPath,
            path: entryPath,
          }))
    setEntries(nextEntries)
    setPathInput(nextPath)
  }, [])

  const loadPath = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      applyListing(await clientRef.current.listDirectories(path))
    } catch (err) {
      // A persisted local CWD (such as /app in a container) may be outside the
      // collaboration server allowlist. Keep that policy intact, but recover to
      // the server-provided roots only for that explicit policy rejection.
      const message = err instanceof Error ? err.message : 'Failed to list directories.'
      if (path?.trim() && isOutsideAllowedRootsError(message)) {
        try {
          applyListing(await clientRef.current.listDirectories())
          return
        } catch {
          // Preserve the original policy error when the roots cannot be listed.
        }
      }
      setError(message)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [applyListing, clientRef])

  useEffect(() => {
    if (!open) return
    setShowNewFolder(false)
    setNewFolderName('')
    setError(null)
    void loadPath(initialPathRef.current?.trim() || undefined)
  }, [open, initialPathRef, loadPath])

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath, roots), [currentPath, roots])
  const noRootsConfigured = Boolean(
    error?.includes('FORGE_CWD_ALLOWLIST_ROOTS') ||
      error?.includes('workspace root') ||
      (roots.length === 0 && !loading && error),
  )

  const handleGoToPath = useCallback(async () => {
    const trimmed = pathInput.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const validation = await clientRef.current.validateDirectory(trimmed)
      if (!validation.valid) {
        setError(validation.message ?? 'Directory is not valid.')
        return
      }
      await loadPath(validation.resolvedPath ?? validation.path ?? trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate directory.')
    } finally {
      setLoading(false)
    }
  }, [clientRef, loadPath, pathInput])

  const handleCreateFolder = useCallback(async () => {
    if (!clientRef.current.createDirectory || !currentPath || !newFolderName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const created = await clientRef.current.createDirectory(currentPath, newFolderName.trim())
      setShowNewFolder(false)
      setNewFolderName('')
      await loadPath(created.parentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder.')
    } finally {
      setCreating(false)
    }
  }, [clientRef, currentPath, loadPath, newFolderName])

  const handleUseFolder = useCallback(async () => {
    const candidate = pathInput.trim() || currentPath
    if (!candidate) return
    setSelecting(true)
    setError(null)
    try {
      const validation = await clientRef.current.validateDirectory(candidate)
      if (!validation.valid) {
        setError(validation.message ?? 'Directory is not valid.')
        return
      }
      const resolved = validation.resolvedPath ?? validation.path ?? candidate
      onSelectRef.current(resolved)
      onOpenChangeRef.current(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate directory.')
    } finally {
      setSelecting(false)
    }
  }, [clientRef, currentPath, onOpenChangeRef, onSelectRef, pathInput])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!selecting && !creating) onOpenChangeRef.current(next) }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="space-y-1 border-b px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
          {roots.length > 0 ? (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Allowed roots</Label>
              <div className="flex flex-wrap gap-1.5">
                {roots.map((root) => (
                  <Button
                    key={root}
                    type="button"
                    size="sm"
                    variant={currentPath === root ? 'secondary' : 'outline'}
                    className="h-7 max-w-full truncate text-xs"
                    onClick={() => void loadPath(root)}
                    disabled={loading}
                  >
                    {root}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex min-h-6 flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.path}-${index}`} className="inline-flex items-center gap-1">
                {index > 0 ? <ChevronRight className="size-3 opacity-60" aria-hidden="true" /> : null}
                <button
                  type="button"
                  className="truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-50"
                  onClick={() => void loadPath(crumb.path)}
                  disabled={loading || !crumb.path}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
            {parentPath !== null && parentPath !== undefined ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-7 text-xs"
                onClick={() => void loadPath(parentPath || undefined)}
                disabled={loading}
              >
                Up
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              placeholder="/workspaces/project"
              aria-label="Directory path"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleGoToPath()
                }
              }}
            />
            <Button type="button" variant="outline" onClick={() => void handleGoToPath()} disabled={loading}>
              Go
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh"
              onClick={() => void loadPath(currentPath)}
              disabled={loading}
            >
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          <div className="min-h-[12rem] flex-1 overflow-auto rounded-md border">
            {loading ? (
              <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading folders…
              </div>
            ) : entries.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted-foreground">
                <Folder className="size-5 opacity-60" aria-hidden="true" />
                <p>No subfolders here.</p>
              </div>
            ) : (
              <ul className="divide-y">
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                      onClick={() => void loadPath(entry.path)}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canCreateDirectory && client.createDirectory && currentPath ? (
            <div className="space-y-2">
              {showNewFolder ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    placeholder="New folder name"
                    aria-label="New folder name"
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleCreateFolder()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    onClick={() => void handleCreateFolder()}
                    disabled={creating || !newFolderName.trim()}
                  >
                    {creating ? <Loader2 className="size-4 animate-spin" /> : 'Create'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setShowNewFolder(false)
                      setNewFolderName('')
                    }}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setShowNewFolder(true)}
                  disabled={loading || selecting}
                >
                  <FolderPlus className="size-3.5" />
                  New folder
                </Button>
              )}
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <div className="space-y-1">
                <p>{error}</p>
                {noRootsConfigured ? (
                  <p className="text-muted-foreground">
                    An admin needs to mount and configure a workspace root
                    (`FORGE_CWD_ALLOWLIST_ROOTS`, typically `/workspaces` in Docker).
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t px-4 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChangeRef.current(false)} disabled={selecting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleUseFolder()}
            disabled={selecting || loading || !(pathInput.trim() || currentPath)}
          >
            {selecting ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Validating…
              </>
            ) : (
              'Use this folder'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function buildBreadcrumbs(
  currentPath: string | undefined,
  roots: string[],
): Array<{ label: string; path: string }> {
  if (!currentPath) {
    return [{ label: 'Roots', path: '' }]
  }

  const matchingRoot = roots
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((root) => currentPath === root || currentPath.startsWith(`${root}/`) || currentPath.startsWith(`${root}\\`))

  if (!matchingRoot) {
    return [{ label: currentPath, path: currentPath }]
  }

  const crumbs: Array<{ label: string; path: string }> = [
    { label: matchingRoot, path: matchingRoot },
  ]

  if (currentPath === matchingRoot) {
    return crumbs
  }

  const relative = currentPath.slice(matchingRoot.length).replace(/^[/\\]+/, '')
  const parts = relative.split(/[/\\]/).filter(Boolean)
  let cursor = matchingRoot
  for (const part of parts) {
    cursor = `${cursor}${cursor.endsWith('/') || cursor.endsWith('\\') ? '' : '/'}${part}`
    crumbs.push({ label: part, path: cursor })
  }
  return crumbs
}

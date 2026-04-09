import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createTree,
  asyncDataLoaderFeature,
  selectionFeature,
  hotkeysCoreFeature,
  searchFeature,
} from '@headless-tree/core'
import type { TreeConfig, TreeInstance, TreeState } from '@headless-tree/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X, Loader2, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import '@/styles/file-browser.css'
import { FileTreeNode } from './FileTreeNode'
import { FileIcon } from './FileIcon'
import type { FileListResult } from './use-file-browser-queries'
import { useFileSearch } from './use-file-browser-queries'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

/* ------------------------------------------------------------------ */
/*  Stable useTree — fixes React 18+ Object.is setState bailout       */
/* ------------------------------------------------------------------ */

/**
 * Drop-in replacement for `useTree` from `@headless-tree/react`.
 *
 * The upstream hook passes the same mutated state object reference to
 * React's `setState`, which causes React 18+ to bail out (Object.is
 * sees no change).  We shallow-clone in the `setState` wrapper so
 * React always sees a new reference and re-renders.
 */
function useStableTree<T>(config: TreeConfig<T>): TreeInstance<T> {
  // Hold tree as a stable object in state (not a pseudo-ref) so render-time
  // access doesn't trigger react-hooks/refs warnings.
  const [tree] = useState(() => createTree<T>(config))
  const [state, setState] = useState(() => tree.getState())

  useEffect(() => {
    tree.setMounted(true)
    tree.rebuildTree()
    return () => {
      tree.setMounted(false)
    }
  }, [tree])

  // Sync config into tree — must run during render so that tree.getItems()
  // and other methods called below see the current config/state immediately.
  // `tree` is a stable state value, not a React ref.
  tree.setConfig((prev) => ({
    ...prev,
    ...config,
    state: { ...state, ...config.state },
    setState: ((newState: TreeState<T>) => {
      setState({ ...newState })
      config.setState?.({ ...newState })
    }) as TreeConfig<T>['setState'],
  }))

  return tree
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FileTreeItem {
  id: string
  name: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileTreeHandle {
  refresh: () => void
  expandToPath: (dirPath: string) => void
  selectFile: (filePath: string) => Promise<void>
}

interface FileTreeProps {
  wsUrl: string
  agentId: string
  cwd: string
  selectedFile: string | null
  onSelectFile: (path: string) => void
  fileCount: number | null
  fileCountMethod: string | null
}

/* ------------------------------------------------------------------ */
/*  Fetch helper (direct, not via hooks — used in tree data loader)    */
/* ------------------------------------------------------------------ */

async function fetchDirectoryListing(
  wsUrl: string,
  agentId: string,
  dirPath: string,
): Promise<FileListResult> {
  const params = new URLSearchParams({ agentId, path: dirPath })
  const url = resolveApiEndpoint(wsUrl, `/api/files/list?${params.toString()}`)
  const response = await fetch(url)

  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: response.statusText }))
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }

  return response.json() as Promise<FileListResult>
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ROOT_ID = 'root'
const ROW_HEIGHT = 28

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(
  function FileTree(
    { wsUrl, agentId, cwd, selectedFile, onSelectFile, fileCount, fileCountMethod },
    ref,
  ) {
    const [filterText, setFilterText] = useState('')
    const [searchQuery, setSearchQuery] = useState('')
    const [searchMode, setSearchMode] = useState(false)
    // Use useState (not useRef) for the scroll container so that when the
    // DOM element mounts via the callback ref, the re-render lets the
    // virtualizer pick up the real element from getScrollElement().
    const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
    const searchScrollRef = useRef<HTMLDivElement>(null)
    const filterInputRef = useRef<HTMLInputElement>(null)

    // Deep search hook
    const searchResult = useFileSearch(wsUrl, agentId, searchQuery)

    // Mutable ref-based stores so the tree data loader closures see fresh data
    // without causing tree config re-creation on every state change.
    const itemDataRef = useRef<Map<string, FileTreeItem>>(new Map())
    const childrenIdsRef = useRef<Map<string, string[]>>(new Map())

    // Stable fetch function ref
    const wsUrlRef = useRef(wsUrl)
    const agentIdRef = useRef(agentId)
    wsUrlRef.current = wsUrl
    agentIdRef.current = agentId

    const loadAndCacheChildren = useCallback(
      async (itemId: string): Promise<string[]> => {
        const dirPath = itemId === ROOT_ID ? '' : itemId
        const result = await fetchDirectoryListing(
          wsUrlRef.current,
          agentIdRef.current,
          dirPath,
        )

        const ids: string[] = []
        for (const entry of result.entries) {
          const entryId = dirPath ? `${dirPath}/${entry.name}` : entry.name
          ids.push(entryId)
          itemDataRef.current.set(entryId, {
            id: entryId,
            name: entry.name,
            type: entry.type,
            size: entry.size,
          })
        }

        childrenIdsRef.current.set(itemId, ids)
        return ids
      },
      [],
    )

    // Stable data loader — getChildren returns a Promise for uncached dirs,
    // which activates asyncDataLoaderFeature's built-in loading state.
    const dataLoader = useMemo(
      () => ({
        getItem: (itemId: string): FileTreeItem => {
          if (itemId === ROOT_ID) {
            return { id: ROOT_ID, name: ROOT_ID, type: 'directory' }
          }
          return (
            itemDataRef.current.get(itemId) ?? {
              id: itemId,
              name: itemId.split('/').pop() ?? itemId,
              type: 'file' as const,
            }
          )
        },
        getChildren: (itemId: string): string[] | Promise<string[]> => {
          const cached = childrenIdsRef.current.get(itemId)
          if (cached) return cached
          // Return a Promise — asyncDataLoaderFeature will handle loading state
          return loadAndCacheChildren(itemId)
        },
      }),
      [loadAndCacheChildren],
    )

    const tree = useStableTree<FileTreeItem>({
      rootItemId: ROOT_ID,
      getItemName: (item) => item.getItemData().name,
      isItemFolder: (item) => item.getItemData().type === 'directory',
      dataLoader,
      features: [
        asyncDataLoaderFeature,
        selectionFeature,
        hotkeysCoreFeature,
        searchFeature,
      ],
      createLoadingItemData: () => ({
        id: '__loading__',
        name: 'Loading…',
        type: 'file' as const,
      }),
    })

    // Wire search feature to filter input (only when NOT in deep search mode)
    useEffect(() => {
      if (searchMode) {
        tree.setSearch(null)
        return
      }
      const trimmed = filterText.trim()
      tree.setSearch(trimmed.length > 0 ? trimmed : null)
    }, [filterText, searchMode, tree])

    // Handle clicks — only select files; the library's getProps() onClick
    // already manages expand/collapse for folders.
    const handleItemClick = useCallback(
      (itemId: string, isFolder: boolean) => {
        if (!isFolder) {
          onSelectFile(itemId)
        }
      },
      [onSelectFile],
    )

    // Refresh: clear caches and rebuild the tree
    const refresh = useCallback(() => {
      itemDataRef.current.clear()
      childrenIdsRef.current.clear()
      tree.rebuildTree()
    }, [tree])

    // Expand tree to a specific directory path (for breadcrumb navigation)
    const expandToPath = useCallback(
      async (dirPath: string) => {
        const segments = dirPath.split('/')
        let currentPath = ''

        // Ensure root children are loaded
        if (!childrenIdsRef.current.has(ROOT_ID)) {
          await loadAndCacheChildren(ROOT_ID)
          tree.rebuildTree()
        }

        // Expand each segment in the path
        for (let i = 0; i < segments.length; i++) {
          currentPath = i === 0 ? segments[i] : `${currentPath}/${segments[i]}`

          // Ensure this directory's children are loaded
          if (!childrenIdsRef.current.has(currentPath)) {
            await loadAndCacheChildren(currentPath)
            tree.rebuildTree()
          }

          // Expand the directory
          try {
            const item = tree.getItemInstance(currentPath)
            if (item && !item.isExpanded()) {
              item.expand()
            }
          } catch {
            // Item may not exist yet in tree — continue
          }
        }
      },
      [tree, loadAndCacheChildren],
    )

    // Navigate to a file from search results: expand tree path, select file
    const selectFile = useCallback(
      async (filePath: string) => {
        // Exit search mode
        setSearchMode(false)
        setSearchQuery('')
        setFilterText('')
        tree.setSearch(null)

        // Expand parent directory
        const parts = filePath.split('/')
        if (parts.length > 1) {
          const parentDir = parts.slice(0, -1).join('/')
          await expandToPath(parentDir)
        } else {
          // Root-level file — ensure root is loaded
          if (!childrenIdsRef.current.has(ROOT_ID)) {
            await loadAndCacheChildren(ROOT_ID)
            tree.rebuildTree()
          }
        }

        // Select the file
        onSelectFile(filePath)
      },
      [expandToPath, loadAndCacheChildren, tree, onSelectFile],
    )

    // Expose refresh, expandToPath, selectFile to parent via imperative handle
    useImperativeHandle(
      ref,
      () => ({ refresh, expandToPath, selectFile }),
      [refresh, expandToPath, selectFile],
    )

    // Get the flat list of visible items (search feature auto-filters)
    const allItems = tree.getItems()

    // Virtualizer
    // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer returns unstable functions by design; this component doesn't pass them to memoized children
    const virtualizer = useVirtualizer({
      count: allItems.length,
      getScrollElement: () => scrollEl,
      estimateSize: () => ROW_HEIGHT,
      overscan: 15,
    })

    // Keyboard: focus filter input on "/"
    useEffect(() => {
      const el = tree.getElement()
      if (!el) return

      const handler = (e: KeyboardEvent) => {
        if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          filterInputRef.current?.focus()
        }
      }
      el.addEventListener('keydown', handler)
      return () => el.removeEventListener('keydown', handler)
    }, [tree])

    return (
      <div className="flex h-full flex-col">
        {/* Search/filter input */}
        <div className="shrink-0 border-b border-border/40 px-2 py-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <input
              ref={filterInputRef}
              type="text"
              value={filterText}
              onChange={(e) => {
                const val = e.target.value
                setFilterText(val)
                // If in search mode and user clears the input, exit search mode
                if (searchMode && val.trim() === '') {
                  setSearchMode(false)
                  setSearchQuery('')
                }
              }}
              placeholder={searchMode ? 'Search files…' : 'Filter files… (Enter to search)'}
              className={cn(
                'h-7 w-full rounded-md border border-border/50 bg-muted/30 pl-7 text-xs',
                searchMode || filterText ? 'pr-7' : 'pr-2',
                'placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none',
              )}
              aria-label="Filter files"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = filterText.trim()
                  if (trimmed.length > 0) {
                    setSearchMode(true)
                    setSearchQuery(trimmed)
                  }
                  e.preventDefault()
                } else if (e.key === 'Escape') {
                  if (searchMode) {
                    setSearchMode(false)
                    setSearchQuery('')
                    setFilterText('')
                    tree.setSearch(null)
                    e.stopPropagation()
                  } else if (filterText) {
                    setFilterText('')
                    e.stopPropagation()
                  }
                }
              }}
            />
            {/* Clear button */}
            {(searchMode || filterText) && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                onClick={() => {
                  setSearchMode(false)
                  setSearchQuery('')
                  setFilterText('')
                  tree.setSearch(null)
                  filterInputRef.current?.focus()
                }}
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Search results (replaces tree when in search mode) */}
        {searchMode ? (
          <>
            <div
              ref={searchScrollRef}
              className="file-browser-scroll min-h-0 flex-1 overflow-auto"
            >
              {searchResult.isLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Searching…</span>
                </div>
              ) : searchResult.error ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  <p className="text-destructive">Search failed</p>
                  <p className="mt-1 opacity-70">{searchResult.error}</p>
                </div>
              ) : searchResult.data?.unavailable ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Search requires a git repository
                </div>
              ) : searchResult.data && searchResult.data.results.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-xs text-muted-foreground">
                  <FileText className="size-6 opacity-30" />
                  <span>No files found</span>
                </div>
              ) : searchResult.data ? (
                <div className="py-1">
                  {searchResult.data.results.map((item) => (
                    <SearchResultItem
                      key={item.path}
                      filePath={item.path}
                      query={searchQuery}
                      isSelected={selectedFile === item.path}
                      onClick={() => selectFile(item.path)}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            {/* Search result count footer */}
            {searchResult.data && !searchResult.data.unavailable && searchResult.data.results.length > 0 ? (
              <div className="flex h-7 shrink-0 items-center border-t border-border/40 px-3 text-[11px] text-muted-foreground/70">
                Showing {searchResult.data.results.length} of{' '}
                {searchResult.data.totalMatches.toLocaleString()} results
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* Tree */}
            <div
              {...tree.getContainerProps('File tree')}
              ref={(el) => {
                setScrollEl(el)
                tree.registerElement(el)
              }}
              className="file-browser-scroll min-h-0 flex-1 overflow-auto focus:outline-none"
              tabIndex={0}
            >
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: 'relative',
                  width: '100%',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const treeItem = allItems[virtualItem.index]
                  if (!treeItem) return null

                  const itemData = treeItem.getItemData()
                  const itemId = treeItem.getId()
                  const isFolder = treeItem.isFolder()
                  const isExpanded = treeItem.isExpanded()
                  const isFocused = treeItem.isFocused()
                  const isSelected = selectedFile === itemId
                  const isLoading = isFolder && treeItem.isLoading()
                  const meta = treeItem.getItemMeta()

                  return (
                    <div
                      key={itemId}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      {...treeItem.getProps()}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <FileTreeNode
                        name={itemData.name}
                        path={itemId}
                        cwd={cwd}
                        type={itemData.type}
                        depth={meta.level - 1}
                        isExpanded={isExpanded}
                        isSelected={isSelected}
                        isFocused={isFocused}
                        isLoading={isLoading}
                        onClick={() =>
                          handleItemClick(itemId, isFolder)
                        }
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            {/* File count footer */}
            {fileCount !== null && fileCountMethod !== 'none' ? (
              <div className="flex h-7 shrink-0 items-center border-t border-border/40 px-3 text-[11px] text-muted-foreground/70">
                {fileCount.toLocaleString()} files
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  },
)

/* ------------------------------------------------------------------ */
/*  Search result item                                                 */
/* ------------------------------------------------------------------ */

function SearchResultItem({
  filePath,
  query,
  isSelected,
  onClick,
}: {
  filePath: string
  query: string
  isSelected: boolean
  onClick: () => void
}) {
  const fileName = filePath.split('/').pop() ?? filePath
  const dirPath = filePath.includes('/')
    ? filePath.slice(0, filePath.lastIndexOf('/'))
    : ''

  // Highlight matching portions of the path
  const highlighted = highlightMatch(filePath, query)

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
        'hover:bg-accent/50',
        isSelected && 'bg-accent text-accent-foreground',
      )}
      onClick={onClick}
      title={filePath}
    >
      <FileIcon key={fileName} fileName={fileName} isDirectory={false} />
      <div className="min-w-0 flex-1">
        <div className="truncate" dangerouslySetInnerHTML={{ __html: highlighted }} />
        {dirPath && (
          <div className="truncate text-[11px] text-muted-foreground/70">
            {dirPath}
          </div>
        )}
      </div>
    </button>
  )
}

/**
 * Highlight all occurrences of `query` in `text` (case-insensitive).
 * Returns an HTML string with `<mark>` tags around matches.
 */
function highlightMatch(text: string, query: string): string {
  if (!query) return escapeHtml(text)

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: string[] = []
  let lastIndex = 0

  let idx = lowerText.indexOf(lowerQuery, lastIndex)
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, idx)))
    }
    parts.push(
      `<mark class="bg-primary/25 text-foreground rounded-sm px-0.5">${escapeHtml(text.slice(idx, idx + query.length))}</mark>`,
    )
    lastIndex = idx + query.length
    idx = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)))
  }

  return parts.join('')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

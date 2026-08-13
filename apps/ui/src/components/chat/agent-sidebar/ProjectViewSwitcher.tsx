import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Eye, ListFilter, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SidebarProjectView } from './hooks'

export interface SidebarProjectViewOption {
  key: string
  label: string
  originLabel?: string
}

interface ProjectViewSwitcherProps {
  options: SidebarProjectViewOption[]
  views: SidebarProjectView[]
  activeView: SidebarProjectView | null
  onSelectView: (viewId: string | null) => void
  onSaveView: (input: {
    id?: string
    name: string
    projectKeys: string[]
    activate?: boolean
  }) => string
  onDeleteView: (viewId: string) => void
  /** Compact chip for the Rooms command row. */
  compact?: boolean
}

interface EditorState {
  view: SidebarProjectView | null
}

export function ProjectViewSwitcher({
  options,
  views,
  activeView,
  onSelectView,
  onSaveView,
  onDeleteView,
  compact = false,
}: ProjectViewSwitcherProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const availableKeys = useMemo(() => new Set(options.map((option) => option.key)), [options])
  const activeAvailableCount = activeView?.projectKeys.filter((key) => availableKeys.has(key)).length ?? 0

  return (
    <>
      <div className={compact ? 'shrink-0' : 'px-2 pb-1'}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                compact
                  ? 'flex h-6 max-w-28 items-center gap-1 rounded-md border px-1.5 text-left text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60'
                  : 'flex h-7 w-full items-center gap-2 rounded-md border px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                activeView
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                  : 'border-sidebar-border bg-sidebar-accent/20 text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
              aria-label={`Project view: ${activeView?.name ?? 'All projects'}`}
            >
              {activeView ? (
                <Eye className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ListFilter className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className={cn('min-w-0 flex-1 truncate font-medium', compact && 'max-w-20')}>
                {activeView?.name ?? 'All projects'}
              </span>
              {!compact ? (
                <span className="shrink-0 text-[10px] opacity-70">
                  {activeView ? activeAvailableCount : options.length}
                </span>
              ) : null}
              <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[19rem]">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Project view
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onSelectView(null)}>
              <span className="flex size-4 items-center justify-center">
                {!activeView ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
              <span className="flex-1">All projects</span>
              <span className="text-xs text-muted-foreground">{options.length}</span>
            </DropdownMenuItem>
            {views.map((view) => {
              const count = view.projectKeys.filter((key) => availableKeys.has(key)).length
              return (
                <DropdownMenuItem key={view.id} onSelect={() => onSelectView(view.id)}>
                  <span className="flex size-4 items-center justify-center">
                    {activeView?.id === view.id ? <Check className="size-3.5" aria-hidden="true" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  <span className="text-xs text-muted-foreground">{count}</span>
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            {activeView ? (
              <DropdownMenuItem onSelect={() => setEditor({ view: activeView })}>
                <Pencil aria-hidden="true" />
                Edit current view
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => setEditor({ view: null })}>
              <Plus aria-hidden="true" />
              New project view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ProjectViewEditor
        key={editor?.view?.id ?? (editor ? 'new' : 'closed')}
        open={editor !== null}
        view={editor?.view ?? null}
        options={options}
        views={views}
        onClose={() => setEditor(null)}
        onSave={(input) => {
          onSaveView({ ...input, activate: true })
          setEditor(null)
        }}
        onDelete={(viewId) => {
          onDeleteView(viewId)
          setEditor(null)
        }}
      />
    </>
  )
}

function ProjectViewEditor({
  open,
  view,
  options,
  views,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  view: SidebarProjectView | null
  options: SidebarProjectViewOption[]
  views: SidebarProjectView[]
  onClose: () => void
  onSave: (input: { id?: string; name: string; projectKeys: string[] }) => void
  onDelete: (viewId: string) => void
}) {
  const [name, setName] = useState(view?.name ?? '')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(view?.projectKeys ?? []),
  )

  useEffect(() => {
    if (!open) return
    setName(view?.name ?? '')
    setSelectedKeys(new Set(view?.projectKeys ?? []))
  }, [open, view])

  const trimmedName = name.trim()
  const duplicateName = views.some(
    (entry) => entry.id !== view?.id && entry.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
  )
  const availableSelectionCount = options.filter((option) => selectedKeys.has(option.key)).length
  const unavailableKeys = view?.projectKeys.filter(
    (key) => !options.some((option) => option.key === key),
  ) ?? []
  const canSave = trimmedName.length > 0 && availableSelectionCount > 0 && !duplicateName

  const setAll = () => {
    setSelectedKeys(new Set([
      ...unavailableKeys,
      ...options.map((option) => option.key),
    ]))
  }
  const clearAvailable = () => setSelectedKeys(new Set(unavailableKeys))

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-md p-5">
        <DialogHeader>
          <DialogTitle>{view ? 'Edit project view' : 'New project view'}</DialogTitle>
          <DialogDescription>
            Choose exactly which projects can appear while this view is active.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <label className="block space-y-1.5 text-xs font-medium">
            <span>View name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer name"
              autoFocus
            />
            {duplicateName ? (
              <span className="text-destructive">A view with this name already exists.</span>
            ) : null}
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Projects</span>
              <div className="flex items-center gap-1 text-[11px]">
                <button type="button" onClick={setAll} className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  Select all
                </button>
                <button type="button" onClick={clearAvailable} className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1.5">
              {options.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No projects are currently available.
                </p>
              ) : options.map((option) => {
                const checked = selectedKeys.has(option.key)
                return (
                  <label
                    key={option.key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/60"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(nextChecked) => {
                        setSelectedKeys((current) => {
                          const next = new Set(current)
                          if (nextChecked) next.add(option.key)
                          else next.delete(option.key)
                          return next
                        })
                      }}
                      aria-label={`Include ${option.label}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.originLabel ? (
                      <span className="max-w-28 truncate text-[10px] text-muted-foreground">
                        {option.originLabel}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
            {unavailableKeys.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {unavailableKeys.length} unavailable project{unavailableKeys.length === 1 ? '' : 's'} will remain in this view.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="mt-5 flex-row items-center sm:justify-between sm:space-x-0">
          <div>
            {view ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onDelete(view.id)}
              >
                <Trash2 className="mr-1.5 size-3.5" aria-hidden="true" />
                Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => onSave({
                id: view?.id,
                name: trimmedName,
                projectKeys: [...selectedKeys],
              })}
            >
              {view ? 'Save view' : 'Create view'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

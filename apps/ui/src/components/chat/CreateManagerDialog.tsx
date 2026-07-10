import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchModelOverrides, type ModelOverridesResponse } from '@/components/settings/models-api'
import {
  MANAGER_REASONING_LEVELS,
  type ManagerExactModelSelection,
  type ManagerReasoningLevel,
  type RepositoryProjectCreationStage,
} from '@forge/protocol'
import {
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
  type ManagerModelSelectRow,
} from '@/lib/manager-model-selection'
import {
  ServerDirectoryBrowserDialog,
  type ServerDirectoryBrowserClient,
} from '@/components/chat/ServerDirectoryBrowserDialog'
import {
  deriveRepositoryFolderFromUrl,
  formatCloneStageLabel,
  joinRepositoryDestination,
} from '@/lib/repository-project-helpers'

const REASONING_LEVEL_LABELS: Record<ManagerReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
  max: 'Max',
  ultra: 'Ultra',
}

export type CreateProjectSourceMode = 'local_folder' | 'clone_repository'

interface CreateManagerDialogProps {
  open: boolean
  wsUrl?: string
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerModelSelection: ManagerExactModelSelection | undefined
  newManagerReasoningLevel: ManagerReasoningLevel | undefined
  scaffoldForgeResources: boolean
  createManagerError: string | null
  browseError: string | null
  /** When false, hide Clone repository (remote / collab surfaces). */
  cloneRepositoryEnabled?: boolean
  sourceMode?: CreateProjectSourceMode
  repositoryUrl?: string
  repositoryFolder?: string
  repositoryBasePath?: string
  cloneStage?: RepositoryProjectCreationStage | null
  clonePercent?: number | null
  cloneCancellable?: boolean
  isCancellingClone?: boolean
  onSourceModeChange?: (mode: CreateProjectSourceMode) => void
  onRepositoryUrlChange?: (value: string) => void
  onRepositoryFolderChange?: (value: string) => void
  onRepositoryBasePathChange?: (value: string) => void
  onBrowseRepositoryBasePath?: () => void
  onCancelClone?: () => void
  onOpenChange: (open: boolean) => void
  onNameChange: (value: string) => void
  onCwdChange: (value: string) => void
  onModelSelectionChange: (value: ManagerExactModelSelection) => void
  onReasoningLevelChange: (value: ManagerReasoningLevel) => void
  onScaffoldForgeResourcesChange: (checked: boolean) => void
  /** Native directory picker; omit for remote origins (no local dialogs). */
  onBrowseDirectory?: () => void
  /** Remote server folder browser; omit for local origins. */
  serverDirectoryBrowser?: {
    client: ServerDirectoryBrowserClient
    canCreateDirectory?: boolean
  }
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function CreateManagerDialog({
  open,
  wsUrl,
  isCreatingManager,
  isValidatingDirectory,
  isPickingDirectory,
  newManagerName,
  newManagerCwd,
  newManagerModelSelection,
  newManagerReasoningLevel,
  scaffoldForgeResources,
  createManagerError,
  browseError,
  cloneRepositoryEnabled = false,
  sourceMode = 'local_folder',
  repositoryUrl = '',
  repositoryFolder = '',
  repositoryBasePath = '',
  cloneStage = null,
  clonePercent = null,
  cloneCancellable = false,
  isCancellingClone = false,
  onSourceModeChange,
  onRepositoryUrlChange,
  onRepositoryFolderChange,
  onRepositoryBasePathChange,
  onBrowseRepositoryBasePath,
  onCancelClone,
  onOpenChange,
  onNameChange,
  onCwdChange,
  onModelSelectionChange,
  onReasoningLevelChange,
  onScaffoldForgeResourcesChange,
  onBrowseDirectory,
  serverDirectoryBrowser,
  onSubmit,
}: CreateManagerDialogProps) {
  const [overridesData, setOverridesData] = useState<ModelOverridesResponse | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  const [serverBrowserOpen, setServerBrowserOpen] = useState(false)
  const [basePathBrowserOpen, setBasePathBrowserOpen] = useState(false)

  const isCloneMode = cloneRepositoryEnabled && sourceMode === 'clone_repository'
  const destinationPreview = isCloneMode
    ? joinRepositoryDestination(repositoryBasePath, repositoryFolder)
    : ''

  const loadAvailability = useCallback(() => {
    setAvailabilityLoading(true)
    setAvailabilityError(null)
    void fetchModelOverrides(wsUrl).then((data) => {
      setOverridesData(data)
      setAvailabilityLoading(false)
    }).catch((err) => {
      setAvailabilityError(err instanceof Error ? err.message : 'Failed to load model availability')
      setAvailabilityLoading(false)
    })
  }, [wsUrl])

  useEffect(() => {
    if (!open) return
    loadAvailability()
  }, [open, loadAvailability])

  useEffect(() => {
    if (!open) {
      setServerBrowserOpen(false)
      setBasePathBrowserOpen(false)
    }
  }, [open])

  const rows = useMemo(() => {
    if (!overridesData) return []
    return buildManagerModelRows(
      'create',
      overridesData.overrides,
      overridesData.providerAvailability,
    )
  }, [overridesData])

  const availableRows = useMemo(() => rows.filter((r) => !r.unavailableReason), [rows])
  const groups = useMemo(() => groupManagerModelRows(availableRows), [availableRows])

  const selectedValue = newManagerModelSelection
    ? encodeManagerModelValue(newManagerModelSelection.provider, newManagerModelSelection.modelId)
    : undefined

  useEffect(() => {
    if (!open || availableRows.length === 0 || availabilityLoading) return

    if (selectedValue && availableRows.some((r) => r.key === selectedValue)) return

    const first = availableRows[0]
    onModelSelectionChange({ provider: first.provider, modelId: first.modelId })
    onReasoningLevelChange(first.defaultReasoningLevel)
  }, [availableRows, selectedValue, onModelSelectionChange, onReasoningLevelChange, open, availabilityLoading])

  const handleModelChange = useCallback((value: string) => {
    const decoded = decodeManagerModelValue(value)
    if (decoded) {
      onModelSelectionChange(decoded)
      const row = availableRows.find((r) => r.key === value)
      if (row) {
        onReasoningLevelChange(row.defaultReasoningLevel)
      }
    }
  }, [availableRows, onModelSelectionChange, onReasoningLevelChange])

  const selectedRow: ManagerModelSelectRow | undefined = selectedValue
    ? availableRows.find((r) => r.key === selectedValue)
    : undefined
  const availableReasoningLevels = useMemo(
    () => selectedRow?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS],
    [selectedRow?.supportedReasoningLevels],
  )

  useEffect(() => {
    if (newManagerReasoningLevel && !availableReasoningLevels.includes(newManagerReasoningLevel)) {
      onReasoningLevelChange(selectedRow?.defaultReasoningLevel ?? 'high')
    }
  }, [availableReasoningLevels, newManagerReasoningLevel, onReasoningLevelChange, selectedRow?.defaultReasoningLevel])

  const availabilityLoaded = !!overridesData && !availabilityLoading
  const noModelsAvailable = availabilityLoaded && availableRows.length === 0
  const isModelSelectorDisabled = isCreatingManager || isPickingDirectory || availabilityLoading || !!availabilityError || noModelsAvailable
  const dismissBlocked = isCreatingManager || isCancellingClone
  const showCancelClone = isCloneMode && (isCreatingManager || isCancellingClone) && (cloneCancellable || isCancellingClone)

  const submitLabel = (() => {
    if (isCancellingClone) {
      return 'Cancelling…'
    }
    if (!isCreatingManager) {
      return isCloneMode ? 'Clone & create project' : 'Create project'
    }
    if (isCloneMode) {
      return formatCloneStageLabel(cloneStage, clonePercent ?? undefined)
    }
    return isValidatingDirectory ? 'Validating...' : 'Creating...'
  })()

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissBlocked) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          if (dismissBlocked) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (dismissBlocked) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (dismissBlocked) event.preventDefault()
        }}
        aria-describedby={createManagerError ? 'create-manager-error' : undefined}
      >
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            {isCloneMode
              ? 'Clone a Git repository, then create a project in the cloned folder.'
              : 'Create a new project with a name and working directory.'}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
          {cloneRepositoryEnabled ? (
            <div className="space-y-2" aria-label="Project source">
              <Label className="text-xs font-medium text-muted-foreground">Source</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  aria-pressed={sourceMode === 'local_folder'}
                  variant={sourceMode === 'local_folder' ? 'default' : 'outline'}
                  disabled={isCreatingManager || isCancellingClone}
                  onClick={() => onSourceModeChange?.('local_folder')}
                >
                  Use local folder
                </Button>
                <Button
                  type="button"
                  size="sm"
                  aria-pressed={sourceMode === 'clone_repository'}
                  variant={sourceMode === 'clone_repository' ? 'default' : 'outline'}
                  disabled={isCreatingManager || isCancellingClone}
                  onClick={() => onSourceModeChange?.('clone_repository')}
                >
                  Clone repository
                </Button>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="manager-name" className="text-xs font-medium text-muted-foreground">
              Name
            </Label>
            <Input
              id="manager-name"
              placeholder="my-project"
              value={newManagerName}
              onChange={(event) => onNameChange(event.target.value)}
              autoFocus
              disabled={isCreatingManager}
            />
          </div>

          {isCloneMode ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="repository-url" className="text-xs font-medium text-muted-foreground">
                  Repository URL
                </Label>
                <Input
                  id="repository-url"
                  placeholder="https://github.com/org/repo.git"
                  value={repositoryUrl}
                  onChange={(event) => onRepositoryUrlChange?.(event.target.value)}
                  disabled={isCreatingManager}
                />
                <p className="text-[11px] text-muted-foreground">
                  HTTPS or SSH URLs. Private repos use your system Git/SSH credentials — not Forge model auth.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="repository-folder" className="text-xs font-medium text-muted-foreground">
                  Repository folder
                </Label>
                <Input
                  id="repository-folder"
                  placeholder={deriveRepositoryFolderFromUrl(repositoryUrl) ?? 'repo'}
                  value={repositoryFolder}
                  onChange={(event) => onRepositoryFolderChange?.(event.target.value)}
                  disabled={isCreatingManager}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="repository-base" className="text-xs font-medium text-muted-foreground">
                  Destination base path
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="repository-base"
                    placeholder="/Users/you/repos"
                    value={repositoryBasePath}
                    onChange={(event) => onRepositoryBasePathChange?.(event.target.value)}
                    disabled={isCreatingManager}
                  />
                  {onBrowseRepositoryBasePath ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onBrowseRepositoryBasePath}
                      disabled={isPickingDirectory || isCreatingManager}
                    >
                      {isPickingDirectory ? 'Browsing...' : 'Choose'}
                    </Button>
                  ) : serverDirectoryBrowser ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setBasePathBrowserOpen(true)}
                      disabled={isPickingDirectory || isCreatingManager}
                    >
                      Browse server…
                    </Button>
                  ) : null}
                </div>
                {destinationPreview ? (
                  <p className="text-[11px] text-muted-foreground">
                    Will clone to <span className="font-mono text-foreground">{destinationPreview}</span>
                  </p>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  Defaults follow Settings → General → Repositories: configured home, otherwise last-used base, otherwise your home directory.
                </p>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="manager-cwd" className="text-xs font-medium text-muted-foreground">
                Working directory
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="manager-cwd"
                  placeholder="/path/to/project"
                  value={newManagerCwd}
                  onChange={(event) => onCwdChange(event.target.value)}
                  disabled={isCreatingManager}
                />
                {serverDirectoryBrowser ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setServerBrowserOpen(true)}
                    disabled={isPickingDirectory || isCreatingManager}
                  >
                    Browse server…
                  </Button>
                ) : onBrowseDirectory ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onBrowseDirectory}
                    disabled={isPickingDirectory || isCreatingManager}
                  >
                    {isPickingDirectory ? 'Browsing...' : 'Browse'}
                  </Button>
                ) : null}
              </div>

              <p className="text-[11px] text-muted-foreground">
                {serverDirectoryBrowser
                  ? 'Browse the remote server for an allowed workspace folder, or enter a path manually.'
                  : 'Use Browse to open the native folder picker, or enter a path manually.'}
              </p>
            </div>
          )}

          {browseError ? (
            <p className="text-xs text-destructive">{browseError}</p>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="manager-model" className="text-xs font-medium text-muted-foreground">
              Default Model
            </Label>
            <Select
              value={selectedValue ?? ''}
              onValueChange={handleModelChange}
              disabled={isModelSelectorDisabled}
            >
              <SelectTrigger id="manager-model" className="w-full">
                <SelectValue placeholder={availabilityLoading ? 'Loading models...' : 'Select model'} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectGroup key={group.provider}>
                    <SelectLabel className="text-xs text-muted-foreground">{group.providerDisplayName}</SelectLabel>
                    {group.rows.map((row) => (
                      <SelectItem key={row.key} value={row.key}>
                        {row.displayName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {availabilityError ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-destructive">Failed to load models.</p>
                <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs text-primary underline-offset-4 hover:underline" onClick={loadAvailability}>
                  Retry
                </Button>
              </div>
            ) : null}
            {noModelsAvailable ? (
              <p className="text-xs text-muted-foreground">
                No manager models are currently available. Re-enable one in Settings &gt; Models.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="manager-reasoning" className="text-xs font-medium text-muted-foreground">
              Reasoning Level
            </Label>
            <Select
              value={newManagerReasoningLevel ?? ''}
              onValueChange={(value) => onReasoningLevelChange(value as ManagerReasoningLevel)}
              disabled={isModelSelectorDisabled}
            >
              <SelectTrigger id="manager-reasoning" className="w-full">
                <SelectValue placeholder="Select reasoning level" />
              </SelectTrigger>
              <SelectContent>
                {availableReasoningLevels.map((level) => (
                  <SelectItem key={level} value={level}>
                    {REASONING_LEVEL_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Higher reasoning uses more tokens but improves complex task performance.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="scaffold-forge-resources"
              checked={scaffoldForgeResources}
              onCheckedChange={(checked) => onScaffoldForgeResourcesChange(checked === true)}
              disabled={isCreatingManager}
            />
            <div className="grid gap-0.5 leading-none">
              <Label htmlFor="scaffold-forge-resources" className="text-xs font-medium text-foreground leading-none cursor-pointer">
                Create .forge project resources
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Adds a .forge directory for project-level skills, specialists, and extensions.
              </p>
            </div>
          </div>

          {createManagerError ? (
            <p id="create-manager-error" role="alert" className="text-xs text-destructive">
              {createManagerError}
            </p>
          ) : null}

          {isCloneMode && (isCreatingManager || isCancellingClone) ? (
            <p className="text-[11px] text-muted-foreground" role="status" aria-live="polite">
              {isCancellingClone
                ? 'Cancelling clone…'
                : cloneStage === 'publishing' || cloneStage === 'creating_manager'
                  ? 'The repository is published. This dialog stays open while Forge finishes creating the project.'
                  : formatCloneStageLabel(cloneStage, clonePercent ?? undefined)}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {showCancelClone && onCancelClone ? (
              <Button type="button" variant="outline" onClick={onCancelClone} disabled={isCancellingClone}>
                {isCancellingClone ? 'Cancelling…' : 'Cancel clone'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={dismissBlocked}
              >
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={isCreatingManager || isCancellingClone || isPickingDirectory || availabilityLoading || !!availabilityError || noModelsAvailable}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>

    {serverDirectoryBrowser ? (
      <ServerDirectoryBrowserDialog
        open={serverBrowserOpen}
        onOpenChange={setServerBrowserOpen}
        client={serverDirectoryBrowser.client}
        canCreateDirectory={serverDirectoryBrowser.canCreateDirectory}
        initialPath={newManagerCwd}
        onSelect={(path) => onCwdChange(path)}
      />
    ) : null}

    {serverDirectoryBrowser && isCloneMode ? (
      <ServerDirectoryBrowserDialog
        open={basePathBrowserOpen}
        onOpenChange={setBasePathBrowserOpen}
        client={serverDirectoryBrowser.client}
        canCreateDirectory={false}
        initialPath={repositoryBasePath}
        onSelect={(path) => onRepositoryBasePathChange?.(path)}
      />
    ) : null}
    </>
  )
}

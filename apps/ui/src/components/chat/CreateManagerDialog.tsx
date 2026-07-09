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
} from '@forge/protocol'
import {
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
  type ManagerModelSelectRow,
} from '@/lib/manager-model-selection'

const REASONING_LEVEL_LABELS: Record<ManagerReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
  max: 'Max',
  ultra: 'Ultra',
}

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
  onOpenChange: (open: boolean) => void
  onNameChange: (value: string) => void
  onCwdChange: (value: string) => void
  onModelSelectionChange: (value: ManagerExactModelSelection) => void
  onReasoningLevelChange: (value: ManagerReasoningLevel) => void
  onScaffoldForgeResourcesChange: (checked: boolean) => void
  /** Native directory picker; omit for remote origins (no local dialogs). */
  onBrowseDirectory?: () => void
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
  onOpenChange,
  onNameChange,
  onCwdChange,
  onModelSelectionChange,
  onReasoningLevelChange,
  onScaffoldForgeResourcesChange,
  onBrowseDirectory,
  onSubmit,
}: CreateManagerDialogProps) {
  const [overridesData, setOverridesData] = useState<ModelOverridesResponse | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)

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

  // Auto-select first available row when availability loads (not before)
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
      // When switching models, set reasoning to the new model's default
      const row = availableRows.find((r) => r.key === value)
      if (row) {
        onReasoningLevelChange(row.defaultReasoningLevel)
      }
    }
  }, [availableRows, onModelSelectionChange, onReasoningLevelChange])

  // Get reasoning levels for selected model
  const selectedRow: ManagerModelSelectRow | undefined = selectedValue
    ? availableRows.find((r) => r.key === selectedValue)
    : undefined
  const availableReasoningLevels = useMemo(
    () => selectedRow?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS],
    [selectedRow?.supportedReasoningLevels],
  )

  // Reset reasoning level if not supported by newly selected model
  useEffect(() => {
    if (newManagerReasoningLevel && !availableReasoningLevels.includes(newManagerReasoningLevel)) {
      onReasoningLevelChange(selectedRow?.defaultReasoningLevel ?? 'high')
    }
  }, [availableReasoningLevels, newManagerReasoningLevel, onReasoningLevelChange, selectedRow?.defaultReasoningLevel])

  const availabilityLoaded = !!overridesData && !availabilityLoading
  const noModelsAvailable = availabilityLoaded && availableRows.length === 0
  const isModelSelectorDisabled = isCreatingManager || isPickingDirectory || availabilityLoading || !!availabilityError || noModelsAvailable

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Create a new project with a name and working directory.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
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
            />
          </div>

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
              />
              {onBrowseDirectory ? (
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

            {browseError ? (
              <p className="text-xs text-destructive">{browseError}</p>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              Use Browse to open the native folder picker, or enter a path manually.
            </p>
          </div>

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
            <p className="text-xs text-destructive">{createManagerError}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreatingManager}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isCreatingManager || isPickingDirectory || availabilityLoading || !!availabilityError || noModelsAvailable}>
              {isCreatingManager
                ? isValidatingDirectory
                  ? 'Validating...'
                  : 'Creating...'
                : 'Create project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

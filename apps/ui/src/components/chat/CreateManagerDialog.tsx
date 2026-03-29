import { useEffect, useMemo, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useModelPresets } from '@/lib/model-preset'
import { type ManagerModelPreset } from '@forge/protocol'
import { getCreateManagerFamilies } from '@forge/protocol'

const STATIC_CREATE_MANAGER_FAMILIES = getCreateManagerFamilies()
const STATIC_CREATE_MANAGER_FAMILY_IDS = new Set(
  STATIC_CREATE_MANAGER_FAMILIES.map((family) => family.familyId),
)

interface CreateManagerDialogProps {
  open: boolean
  wsUrl?: string
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerModel: ManagerModelPreset
  createManagerError: string | null
  browseError: string | null
  onOpenChange: (open: boolean) => void
  onNameChange: (value: string) => void
  onCwdChange: (value: string) => void
  onModelChange: (value: ManagerModelPreset) => void
  onBrowseDirectory: () => void
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
  newManagerModel,
  createManagerError,
  browseError,
  onOpenChange,
  onNameChange,
  onCwdChange,
  onModelChange,
  onBrowseDirectory,
  onSubmit,
}: CreateManagerDialogProps) {
  const modelPresets = useModelPresets(wsUrl, open ? 1 : 0)

  const createManagerFamilies = useMemo(() => {
    const presetInfoById = new Map(modelPresets.map((preset) => [preset.presetId, preset]))
    const hasServerFilteredFamilies = modelPresets.length > 0

    return STATIC_CREATE_MANAGER_FAMILIES.flatMap((family) => {
      const preset = presetInfoById.get(family.familyId)
      if (!preset && hasServerFilteredFamilies) {
        return []
      }

      return [{
        familyId: family.familyId,
        displayName: preset?.displayName ?? family.displayName,
      }]
    })
  }, [modelPresets])

  useEffect(() => {
    if (!open) {
      return
    }

    if (!STATIC_CREATE_MANAGER_FAMILY_IDS.has(newManagerModel)) {
      return
    }

    if (createManagerFamilies.some((family) => family.familyId === newManagerModel)) {
      return
    }

    const fallbackFamilyId = createManagerFamilies[0]?.familyId
    if (fallbackFamilyId) {
      onModelChange(fallbackFamilyId as ManagerModelPreset)
    }
  }, [createManagerFamilies, newManagerModel, onModelChange, open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create manager</DialogTitle>
          <DialogDescription>
            Create a new manager with a name and working directory.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="manager-name" className="text-xs font-medium text-muted-foreground">
              Name
            </Label>
            <Input
              id="manager-name"
              placeholder="release-manager"
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
              <Button
                type="button"
                variant="outline"
                onClick={onBrowseDirectory}
                disabled={isPickingDirectory || isCreatingManager}
              >
                {isPickingDirectory ? 'Browsing...' : 'Browse'}
              </Button>
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
              Model
            </Label>
            <Select
              value={newManagerModel}
              onValueChange={(value) => onModelChange(value as ManagerModelPreset)}
              disabled={isCreatingManager || isPickingDirectory}
            >
              <SelectTrigger id="manager-model" className="w-full">
                <SelectValue placeholder="Select model preset" />
              </SelectTrigger>
              <SelectContent>
                {createManagerFamilies.map((family) => (
                  <SelectItem key={family.familyId} value={family.familyId}>
                    {family.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Button type="submit" disabled={isCreatingManager || isPickingDirectory}>
              {isCreatingManager
                ? isValidatingDirectory
                  ? 'Validating...'
                  : 'Creating...'
                : 'Create manager'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function NewSpecialistForm({
  handle,
  displayName,
  normalizedHandle,
  handleConflict,
  isValid,
  isCreating,
  error,
  onHandleChange,
  onDisplayNameChange,
  onCreate,
  onCancel,
}: {
  handle: string
  displayName: string
  normalizedHandle: string
  handleConflict: boolean
  isValid: boolean
  isCreating: boolean
  error: string | null
  onHandleChange: (value: string) => void
  onDisplayNameChange: (value: string) => void
  onCreate: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-4 space-y-3">
      <p className="text-xs font-medium text-foreground">Create New Specialist</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
          <Input
            value={handle}
            onChange={(e) => onHandleChange(e.target.value)}
            placeholder="my-specialist"
            className="h-9 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && !isCreating) onCreate()
              if (e.key === 'Escape') onCancel()
            }}
          />
          {normalizedHandle && normalizedHandle !== handle.trim() && (
            <p className="text-[11px] text-muted-foreground">
              → <span className="font-mono">{normalizedHandle}</span>
            </p>
          )}
          {handleConflict && (
            <p className="text-[11px] text-destructive">
              A specialist with this handle already exists.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Display name</Label>
          <Input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="My Specialist"
            className="h-9 text-sm"
            disabled={isCreating}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && !isCreating) onCreate()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
      </div>
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onCreate} disabled={!isValid || isCreating} className="gap-1">
          {isCreating && <Loader2 className="size-3 animate-spin" />}
          Create
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isCreating}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

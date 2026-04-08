import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import { normalizeHandle } from './utils'

export function HandleField({
  value,
  originalHandle,
  isBuiltin,
  isSaving,
  allSpecialists,
  onChange,
}: {
  value: string
  originalHandle: string
  isBuiltin: boolean
  isSaving: boolean
  allSpecialists: ResolvedSpecialistDefinition[]
  onChange: (value: string) => void
}) {
  const normalized = normalizeHandle(value)
  const isEmpty = normalized.length === 0
  const isConflict =
    normalized !== originalHandle &&
    allSpecialists.some((s) => s.specialistId === normalized)

  if (isBuiltin) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
        <p className="text-sm font-mono text-muted-foreground/70">{originalHandle}.md</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="my-specialist"
        className="h-9 text-sm font-mono"
        disabled={isSaving}
      />
      {normalized && normalized !== value.trim() && !isEmpty && !isConflict && (
        <p className="text-[11px] text-muted-foreground">
          → <span className="font-mono">{normalized}.md</span>
        </p>
      )}
      {normalized && normalized === value.trim() && !isEmpty && !isConflict && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-mono">{normalized}.md</span>
        </p>
      )}
      {isEmpty && value.length > 0 && (
        <p className="text-[11px] text-destructive">Handle cannot be empty.</p>
      )}
      {isConflict && (
        <p className="text-[11px] text-destructive">
          A specialist with handle &quot;{normalized}&quot; already exists.
        </p>
      )}
    </div>
  )
}

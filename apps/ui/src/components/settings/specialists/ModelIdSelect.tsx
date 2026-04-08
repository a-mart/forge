import { useMemo } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select'
import type { ModelPresetInfo } from '@forge/protocol'
import { getModelDisplayLabel } from '@/lib/model-preset'
import type { SelectableModel } from '@/lib/model-preset'
import { encodeSelectableModelKey, decodeSelectableModelKey, groupModelsByProvider } from './utils'

export function ModelIdSelect({
  modelId,
  provider,
  onValueChange,
  models,
  presets,
  placeholder,
  allowNone,
}: {
  modelId: string
  provider: string
  onValueChange: (next: { provider: string; modelId: string }) => void
  models: SelectableModel[]
  presets: ModelPresetInfo[]
  placeholder?: string
  allowNone?: boolean
}) {
  const groups = useMemo(() => groupModelsByProvider(models), [models])

  const itemTextByValue = useMemo(() => {
    const map = new Map<string, string>()
    if (allowNone) map.set('__none__', placeholder ?? 'None')
    for (const g of groups) {
      for (const m of g.models) {
        map.set(m.key, m.label)
      }
    }
    return map
  }, [groups, allowNone, placeholder])

  const selectedKey = modelId && provider ? encodeSelectableModelKey(provider, modelId) : ''
  const controlledValue = allowNone ? (selectedKey || '__none__') : selectedKey

  return (
    <Select
      key={allowNone ? 'fallback' : 'primary'}
      value={controlledValue || undefined}
      onValueChange={(nextValue) => {
        if (allowNone && nextValue === '__none__') {
          onValueChange({ provider: '', modelId: '' })
          return
        }

        const decoded = decodeSelectableModelKey(nextValue)
        if (!decoded) {
          return
        }

        onValueChange(decoded)
      }}
    >
      <SelectTrigger className="w-full text-xs">
        <span className="truncate">
          {controlledValue
            ? (itemTextByValue.get(controlledValue) ?? getModelDisplayLabel(modelId, presets, provider))
            : (placeholder ?? 'Select model')}
        </span>
      </SelectTrigger>
      <SelectContent position="popper">
        {allowNone && (
          <SelectItem value="__none__" className="text-xs">
            <span className="text-muted-foreground">None</span>
          </SelectItem>
        )}
        {groups.map((group) => (
          <SelectGroup key={group.provider}>
            <SelectLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">{group.label}</SelectLabel>
            {group.models.map((m) => (
              <SelectItem key={m.key} value={m.key} className="text-xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { SPECIALIST_COLORS } from './types'

export function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-6 shrink-0 rounded border cursor-pointer transition-shadow hover:ring-2 hover:ring-ring hover:ring-offset-1"
          style={{ backgroundColor: value }}
          aria-label="Pick badge color"
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="end">
        <div className="grid grid-cols-5 gap-1.5">
          {SPECIALIST_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'size-6 rounded-full border-2 cursor-pointer transition-transform hover:scale-110',
                value.toLowerCase() === color.toLowerCase()
                  ? 'border-foreground ring-2 ring-ring ring-offset-1'
                  : 'border-transparent',
              )}
              style={{ backgroundColor: color }}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
              aria-label={`Select color ${color}`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

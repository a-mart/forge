import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleHelp } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** The source badge doubles as the per-field inheritance / clear control. */
export function RoutingSource({ label, value, model, required = false, onReset, onClear, onCustomize, prefix }: {
  label: string
  prefix?: string
  value: unknown
  model: boolean
  required?: boolean
  onReset: () => void
  onClear: () => void
  onCustomize?: () => void
}) {
  const source = value === undefined ? 'Default' : value === null ? 'Cleared' : model ? 'Override' : 'Custom'
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" variant="ghost" className="h-6 gap-1 rounded bg-muted/60 px-1.5 text-[10px] font-normal text-muted-foreground" aria-label={`${label} source: ${required ? 'Required' : source}`}>
      {prefix ? `${prefix}: ` : ''}{required ? 'Required' : source}<ChevronDown className="size-3" />
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuLabel className="text-xs">{required ? `Shared privacy floor · saved: ${source.toLowerCase()}` : label}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={onReset}>{model ? 'Use shared default' : 'Use OpenRouter default'}</DropdownMenuItem>
      <DropdownMenuItem disabled={required} onSelect={onClear}>Clear · no additional restriction</DropdownMenuItem>
      {onCustomize ? <DropdownMenuItem onSelect={onCustomize}>Customize</DropdownMenuItem> : null}
    </DropdownMenuContent>
  </DropdownMenu>
}

export function RoutingSwitchRow({ label, description, help, checked, disabled, onChange, source }: {
  label: string; description?: string; help?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; source: ReactNode
}) {
  return <div className="flex items-center justify-between gap-3">
    <div><label className="cursor-pointer text-[13px]" htmlFor={`routing-${label}`}>{label}</label>{help ? <Tooltip><TooltipTrigger asChild><button type="button" aria-label={`About ${label}`} className="ml-1.5 inline-flex align-middle text-muted-foreground"><CircleHelp className="size-3" /></button></TooltipTrigger><TooltipContent className="max-w-64">{help}</TooltipContent></Tooltip> : null}{description ? <p className="mt-1 text-[11px] text-muted-foreground">{description}</p> : null}</div>
    <div className="flex shrink-0 items-center gap-3">{source}<Switch id={`routing-${label}`} aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} /></div>
  </div>
}

export function RoutingDisclosure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <details className="group/disclosure border-b border-border/60 py-4 last:border-0">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open/disclosure:rotate-90" />{title}{hint ? <span className="ml-auto hidden text-[11px] text-muted-foreground/70 sm:inline">{hint}</span> : null}</summary>
    <div className="mt-4 space-y-5">{children}</div>
  </details>
}

import { useCallback, useMemo, useState } from 'react'
import { Check, Monitor, Moon, RotateCcw, Shuffle, Sun } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  APPEARANCE_CODE_FONTS,
  APPEARANCE_TEMPLATES,
  APPEARANCE_UI_FONTS,
  applyAppearanceConfig,
  getContrastRatio,
  getDefaultAppearanceConfig,
  mixColor,
  readStoredAppearanceConfig,
  resolveAppearanceCssVariables,
  resolveAppearanceIsDark,
  type AppearanceCodeFont,
  type AppearanceConfig,
  type AppearanceFont,
  type AppearanceTemplate,
  type ThemePreference,
} from '@/lib/theme'
import { SettingsSection, SettingsWithCTA } from './settings-row'

const MODE_OPTIONS: Array<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  { value: 'light', label: 'Light', icon: <Sun className="size-3.5" /> },
  { value: 'dark', label: 'Dark', icon: <Moon className="size-3.5" /> },
  { value: 'auto', label: 'System', icon: <Monitor className="size-3.5" /> },
]

export function SettingsAppearance() {
  const [appliedAppearance, setAppliedAppearance] = useState<AppearanceConfig>(() => readStoredAppearanceConfig())
  const [draftAppearance, setDraftAppearance] = useState<AppearanceConfig>(() => readStoredAppearanceConfig())

  const draftIsDirty = !areAppearanceConfigsEqual(draftAppearance, appliedAppearance)

  const previewIsDark = useMemo(() => resolveAppearanceIsDark(draftAppearance.mode), [draftAppearance.mode])

  const previewVariables = useMemo(
    () => resolveAppearanceCssVariables({ ...draftAppearance, customApplied: true }, previewIsDark),
    [draftAppearance, previewIsDark],
  )

  const patchDraft = useCallback((patch: Partial<AppearanceConfig>) => {
    setDraftAppearance((current) => ({ ...current, ...patch, version: 1 }))
  }, [])

  const handleTemplateSelect = useCallback((template: AppearanceTemplate) => {
    setDraftAppearance((current) => ({
      ...current,
      mode: template.preferredMode ?? current.mode,
      accentColor: template.accentColor,
      backgroundColor: template.backgroundColor,
      foregroundColor: template.foregroundColor,
      uiFont: template.uiFont ?? current.uiFont,
      codeFont: template.codeFont ?? current.codeFont,
      templateId: template.id,
      customApplied: false,
    }))
  }, [])

  const handleRandomize = useCallback(() => {
    setDraftAppearance((current) => ({
      ...current,
      ...generateRandomAppearance(),
      customApplied: false,
    }))
  }, [])

  const handleApply = useCallback(() => {
    if (isOriginalForgeDraft(draftAppearance)) {
      const defaults = getDefaultAppearanceConfig()
      setDraftAppearance(defaults)
      setAppliedAppearance(defaults)
      applyAppearanceConfig(defaults, { applyModeWhenCustomDisabled: true })
      return
    }

    const next = { ...draftAppearance, version: 1, customApplied: true } satisfies AppearanceConfig
    setDraftAppearance(next)
    setAppliedAppearance(next)
    applyAppearanceConfig(next)
  }, [draftAppearance])

  const handleReset = useCallback(() => {
    const defaults = getDefaultAppearanceConfig()
    setDraftAppearance(defaults)
    setAppliedAppearance(defaults)
    applyAppearanceConfig(defaults, { applyModeWhenCustomDisabled: true })
  }, [])

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)] xl:items-start xl:gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)] 2xl:gap-6">
      <div className="flex min-w-0 flex-col gap-8">
        <SettingsSection
          label="Appearance"
          description="Draft a device-local appearance, preview it here, then apply it when ready."
        >
        <SettingsWithCTA
          label="Theme mode"
          description="Draft light, dark, or system mode. The app changes only after Apply."
        >
          <div className="grid w-full grid-cols-3 gap-1 rounded-lg border border-border bg-muted/30 p-1 sm:w-80">
            {MODE_OPTIONS.map((option) => {
              const active = draftAppearance.mode === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => patchDraft({ mode: option.value })}
                  className={cn(
                    'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-sm transition-colors',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                  )}
                  aria-pressed={active}
                >
                  {option.icon}
                  {option.label}
                </button>
              )
            })}
          </div>
        </SettingsWithCTA>

        <div className="grid gap-3 sm:grid-cols-3">
          <ColorControl
            label="Accent"
            value={draftAppearance.accentColor}
            onChange={(accentColor) => patchDraft({ accentColor })}
          />
          <ColorControl
            label="Background"
            value={draftAppearance.backgroundColor}
            onChange={(backgroundColor) => patchDraft({ backgroundColor })}
          />
          <ColorControl
            label="Foreground"
            value={draftAppearance.foregroundColor}
            onChange={(foregroundColor) => patchDraft({ foregroundColor })}
          />
        </div>

        <SettingsWithCTA
          label="UI font"
          description="Choose from safe local font stacks. Forge does not load remote fonts for this setting."
        >
          <Select
            value={draftAppearance.uiFont}
            onValueChange={(value) => patchDraft({ uiFont: value as AppearanceFont })}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select UI font" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(APPEARANCE_UI_FONTS) as [AppearanceFont, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>

        <SettingsWithCTA
          label="Code font"
          description="Choose a local monospace stack for code, terminals, and technical text."
        >
          <Select
            value={draftAppearance.codeFont}
            onValueChange={(value) => patchDraft({ codeFont: value as AppearanceCodeFont })}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select code font" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(APPEARANCE_CODE_FONTS) as [AppearanceCodeFont, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>
        </SettingsSection>

        <SettingsSection
          label="Template themes"
          description="Forge-native presets. Selecting one updates the draft and preview only."
        >
        <div className="grid gap-3 lg:grid-cols-2">
          {APPEARANCE_TEMPLATES.map((template) => {
            const active = isTemplateDraftActive(draftAppearance, template)
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => handleTemplateSelect(template)}
                className={cn(
                  'rounded-xl border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary' : 'border-border',
                )}
                aria-pressed={active}
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="size-4 rounded-full border border-border" style={{ backgroundColor: template.accentColor }} />
                    <span className="font-medium text-foreground">{template.name}</span>
                  </div>
                  {active ? <Check className="size-4 text-primary" /> : null}
                </div>
                <div
                  className="mb-2 h-16 rounded-lg border p-2"
                  style={{
                    backgroundColor: template.backgroundColor,
                    borderColor: template.accentColor,
                    color: template.foregroundColor,
                  }}
                  aria-hidden="true"
                >
                  <div className="mb-2 h-2 w-16 rounded-full" style={{ backgroundColor: template.accentColor }} />
                  <div className="h-2 w-full rounded-full opacity-35" style={{ backgroundColor: template.foregroundColor }} />
                  <div className="mt-1 h-2 w-2/3 rounded-full opacity-25" style={{ backgroundColor: template.foregroundColor }} />
                </div>
                <p className="text-xs text-muted-foreground">{template.description}</p>
              </button>
            )
          })}
        </div>
        </SettingsSection>
      </div>

      <div className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-4">
        <SettingsSection
          label="Draft preview"
          description="This card previews the draft only. The rest of Forge will not change until you click Apply."
        >
        <div className="mb-3 flex justify-stretch sm:justify-end xl:justify-stretch">
          <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto xl:w-full" onClick={handleRandomize}>
            <Shuffle className="mr-1.5 size-3.5" />
            Randomize draft
          </Button>
        </div>
        <div
          className="rounded-xl border p-4 shadow-sm"
          style={previewShellStyle(previewVariables)}
        >
          <div className="mb-3 flex flex-col items-start justify-between gap-3 rounded-lg border p-3 sm:flex-row sm:items-center xl:flex-col xl:items-start" style={previewCardStyle(previewVariables)}>
            <div>
              <div className="text-sm font-semibold" style={{ color: previewVariables['--foreground'] }}>Forge workspace</div>
              <div className="text-xs" style={{ color: previewVariables['--muted-foreground'] }}>Draft-only appearance preview</div>
            </div>
            <div
              className="rounded-md px-3 py-1.5 text-xs font-medium"
              style={{ backgroundColor: previewVariables['--primary'], color: previewVariables['--primary-foreground'] }}
            >
              Primary
            </div>
          </div>
          <div className="grid gap-3">
            <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: previewVariables['--muted'], color: previewVariables['--foreground'] }}>
              Draft changes stay inside this preview until you apply them.
            </div>
            <code
              className="min-w-0 rounded-lg border p-3 text-xs"
              style={{
                backgroundColor: previewVariables['--card'],
                borderColor: previewVariables['--border'],
                color: previewVariables['--foreground'],
                fontFamily: previewVariables['--app-font-mono'],
              }}
            >
              --accent: {draftAppearance.accentColor}
            </code>
          </div>
        </div>
        </SettingsSection>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between xl:flex-col xl:items-stretch">
          <p className="text-xs text-muted-foreground">
            {draftIsDirty ? 'You have unapplied draft changes.' : appliedAppearance.customApplied ? 'Custom appearance is applied.' : 'Forge default appearance is active.'}
          </p>
          <div className="flex justify-end gap-2 xl:flex-col">
            <Button type="button" variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="mr-1.5 size-3.5" />
              Reset defaults
            </Button>
            <Button type="button" size="sm" onClick={handleApply} disabled={!draftIsDirty && appliedAppearance.customApplied}>
              Apply appearance
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <Label className="mb-2 block text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer p-1"
          aria-label={`${label} color`}
        />
        <Input
          value={value.toUpperCase()}
          className="font-mono text-xs uppercase"
          aria-label={`${label} hex value`}
          readOnly
        />
      </div>
    </div>
  )
}

function areAppearanceConfigsEqual(a: AppearanceConfig, b: AppearanceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isTemplateDraftActive(draft: AppearanceConfig, template: AppearanceTemplate): boolean {
  return draft.templateId === template.id &&
    draft.accentColor === template.accentColor &&
    draft.backgroundColor === template.backgroundColor &&
    draft.foregroundColor === template.foregroundColor
}

function isOriginalForgeDraft(draft: AppearanceConfig): boolean {
  const defaults = getDefaultAppearanceConfig()
  return draft.templateId === defaults.templateId &&
    draft.mode === defaults.mode &&
    draft.accentColor === defaults.accentColor &&
    draft.backgroundColor === defaults.backgroundColor &&
    draft.foregroundColor === defaults.foregroundColor &&
    draft.uiFont === defaults.uiFont &&
    draft.codeFont === defaults.codeFont
}

function previewShellStyle(vars: Record<string, string>): CSSProperties {
  return {
    backgroundColor: vars['--background'],
    borderColor: vars['--border'],
    color: vars['--foreground'],
    fontFamily: vars['--app-font-sans'],
  }
}

function previewCardStyle(vars: Record<string, string>): CSSProperties {
  return {
    backgroundColor: vars['--card'],
    borderColor: vars['--border'],
    color: vars['--foreground'],
  }
}

function generateRandomAppearance(): Pick<AppearanceConfig, 'mode' | 'accentColor' | 'backgroundColor' | 'foregroundColor' | 'uiFont' | 'codeFont' | 'templateId'> {
  const mode: ThemePreference = Math.random() > 0.45 ? 'light' : 'dark'
  const hue = randomInt(0, 359)
  const accentHue = (hue + randomInt(35, 180)) % 360
  const backgroundColor = hslToHex(hue, randomInt(20, 58), mode === 'dark' ? randomInt(12, 24) : randomInt(88, 97))
  const preferredForeground = mode === 'dark'
    ? hslToHex((hue + randomInt(160, 220)) % 360, randomInt(35, 72), randomInt(82, 94))
    : hslToHex((hue + randomInt(160, 220)) % 360, randomInt(35, 72), randomInt(8, 22))
  const foregroundColor = getContrastRatio(preferredForeground, backgroundColor) >= 7
    ? preferredForeground
    : mode === 'dark' ? '#f8fafc' : '#0f172a'
  const accentColor = hslToHex(accentHue, randomInt(58, 88), mode === 'dark' ? randomInt(48, 70) : randomInt(34, 52))
  const uiFonts: AppearanceFont[] = ['geist', 'system', 'inter', 'serif']
  const codeFonts: AppearanceCodeFont[] = ['geist-mono', 'system-mono', 'jetbrains', 'sf-mono']

  return {
    mode,
    accentColor: ensureAccentSeparation(accentColor, backgroundColor, mode),
    backgroundColor,
    foregroundColor,
    uiFont: uiFonts[randomInt(0, uiFonts.length - 1)],
    codeFont: codeFonts[randomInt(0, codeFonts.length - 1)],
    templateId: 'forge',
  }
}

function ensureAccentSeparation(accent: string, background: string, mode: ThemePreference): string {
  if (getContrastRatio(accent, background) >= 3) return accent
  return mode === 'dark' ? mixColor(accent, '#ffffff', 0.35) : mixColor(accent, '#000000', 0.25)
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100
  const lightness = l / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = lightness - chroma / 2
  let r = 0
  let g = 0
  let b = 0

  if (h < 60) { r = chroma; g = x }
  else if (h < 120) { r = x; g = chroma }
  else if (h < 180) { g = chroma; b = x }
  else if (h < 240) { g = x; b = chroma }
  else if (h < 300) { r = x; b = chroma }
  else { r = chroma; b = x }

  const toHex = (value: number): string => Math.round((value + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

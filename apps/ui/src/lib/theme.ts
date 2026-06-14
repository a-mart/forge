export type ThemePreference = 'light' | 'dark' | 'auto'
export type AppearanceTemplateId = 'forge' | 'aurora' | 'midnight' | 'terminal' | 'sakura' | 'desert'
export type AppearanceFont = 'geist' | 'system' | 'inter' | 'serif'
export type AppearanceCodeFont = 'geist-mono' | 'system-mono' | 'jetbrains' | 'sf-mono'

export interface AppearanceConfig {
  version: 1
  mode: ThemePreference
  accentColor: string
  backgroundColor: string
  foregroundColor: string
  uiFont: AppearanceFont
  codeFont: AppearanceCodeFont
  templateId: AppearanceTemplateId
  /** Custom colors/fonts are applied only after the user explicitly clicks Apply. */
  customApplied: boolean
}

export interface AppearanceTemplate {
  id: AppearanceTemplateId
  name: string
  description: string
  accentColor: string
  backgroundColor: string
  foregroundColor: string
  preferredMode?: ThemePreference
  uiFont?: AppearanceFont
  codeFont?: AppearanceCodeFont
}

export type AppearanceCssVariables = Record<string, string>

const THEME_STORAGE_KEY = 'swarm-theme'
const DARK_CLASS_NAME = 'dark'
const SYSTEM_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

const CUSTOM_APPEARANCE_VARIABLES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--app-font-sans',
  '--app-font-mono',
]

export const APPEARANCE_TEMPLATES: AppearanceTemplate[] = [
  {
    id: 'forge',
    name: 'Original Forge',
    description: 'Restores the true system-driven default Forge skin.',
    accentColor: '#2e7d32',
    backgroundColor: '#f8f5f0',
    foregroundColor: '#3e2723',
    preferredMode: 'auto',
    uiFont: 'system',
    codeFont: 'system-mono',
  },
  {
    id: 'aurora',
    name: 'Aurora Glass',
    description: 'Deep ink, mint energy, and northern-light contrast.',
    accentColor: '#14b8a6',
    backgroundColor: '#ecfeff',
    foregroundColor: '#083344',
    preferredMode: 'auto',
    uiFont: 'system',
  },
  {
    id: 'midnight',
    name: 'Midnight Forge',
    description: 'Dark navy workspace with electric cobalt highlights.',
    accentColor: '#60a5fa',
    backgroundColor: '#e0f2fe',
    foregroundColor: '#082f49',
    preferredMode: 'dark',
  },
  {
    id: 'terminal',
    name: 'Terminal Lime',
    description: 'Operator-style graphite with sharp lime signals.',
    accentColor: '#84cc16',
    backgroundColor: '#f7fee7',
    foregroundColor: '#1a2e05',
    preferredMode: 'dark',
    codeFont: 'system-mono',
  },
  {
    id: 'sakura',
    name: 'Sakura Dawn',
    description: 'Soft rose surfaces with plum text and magenta actions.',
    accentColor: '#db2777',
    backgroundColor: '#fff1f2',
    foregroundColor: '#4a044e',
    preferredMode: 'light',
    uiFont: 'serif',
  },
  {
    id: 'desert',
    name: 'Desert Ember',
    description: 'Sand, clay, and copper for a warmer command center.',
    accentColor: '#c2410c',
    backgroundColor: '#fffbeb',
    foregroundColor: '#431407',
    preferredMode: 'light',
  },
]

export const APPEARANCE_UI_FONTS: Record<AppearanceFont, string> = {
  system: 'System UI',
  geist: 'Geist (if installed)',
  inter: 'Inter/System',
  serif: 'Serif',
}

export const APPEARANCE_CODE_FONTS: Record<AppearanceCodeFont, string> = {
  'system-mono': 'System Mono',
  'geist-mono': 'Geist Mono (if installed)',
  jetbrains: 'JetBrains/System',
  'sf-mono': 'SF Mono/System',
}

const UI_FONT_STACKS: Record<AppearanceFont, string> = {
  geist: '"Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  inter: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", serif',
}

const CODE_FONT_STACKS: Record<AppearanceCodeFont, string> = {
  'geist-mono': '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  'system-mono': 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  'sf-mono': 'SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace',
}

const DEFAULT_APPEARANCE: AppearanceConfig = {
  version: 1,
  mode: 'auto',
  accentColor: '#2e7d32',
  backgroundColor: '#f8f5f0',
  foregroundColor: '#3e2723',
  uiFont: 'system',
  codeFont: 'system-mono',
  templateId: 'forge',
  customApplied: false,
}

let removeSystemThemeListener: (() => void) | null = null

export const THEME_INIT_SCRIPT = `(() => {
  try {
    const storageKey = '${THEME_STORAGE_KEY}';
    const darkClass = '${DARK_CLASS_NAME}';
    const stored = window.localStorage.getItem(storageKey);
    const defaults = ${JSON.stringify(DEFAULT_APPEARANCE)};
    const validHex = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    const isMode = (value) => value === 'light' || value === 'dark' || value === 'auto';
    const isLegacyMode = stored === 'light' || stored === 'dark' || stored === 'auto';
    const config = (() => {
      if (isLegacyMode) return { ...defaults, mode: stored, draftOnly: false };
      if (!stored) return { ...defaults, draftOnly: false };
      try {
        const parsed = JSON.parse(stored);
        const customApplied = parsed?.customApplied === true;
        if (!customApplied) return { ...defaults, draftOnly: false };
        const normalized = {
          ...defaults,
          ...(parsed && typeof parsed === 'object' ? parsed : {}),
          mode: isMode(parsed?.mode) ? parsed.mode : defaults.mode,
          accentColor: validHex(parsed?.accentColor) ? parsed.accentColor : defaults.accentColor,
          backgroundColor: validHex(parsed?.backgroundColor) ? parsed.backgroundColor : defaults.backgroundColor,
          foregroundColor: validHex(parsed?.foregroundColor) ? parsed.foregroundColor : defaults.foregroundColor,
          customApplied,
        };
        const hasDefaultValues =
          normalized.mode === defaults.mode &&
          normalized.accentColor === defaults.accentColor &&
          normalized.backgroundColor === defaults.backgroundColor &&
          normalized.foregroundColor === defaults.foregroundColor &&
          normalized.uiFont === defaults.uiFont &&
          normalized.codeFont === defaults.codeFont &&
          normalized.templateId === defaults.templateId;
        if (hasDefaultValues) {
          try { window.localStorage.removeItem(storageKey); } catch {}
          return { ...defaults, draftOnly: false };
        }
        return { ...normalized, draftOnly: false };
      } catch { return { ...defaults, draftOnly: false }; }
    })();
    if (config.draftOnly) return;
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('${SYSTEM_THEME_MEDIA_QUERY}').matches;
    const isDark = config.mode === 'dark' || (config.mode === 'auto' && prefersDark);
    document.documentElement.classList.toggle(darkClass, isDark);
    if (!config.customApplied) return;
    const style = document.documentElement.style;
    const mix = (hex, other, amount) => {
      const a = hex.replace('#', '');
      const b = other.replace('#', '');
      const n = (i) => parseInt(a.slice(i, i + 2), 16);
      const o = (i) => parseInt(b.slice(i, i + 2), 16);
      const h = (v) => Math.round(v).toString(16).padStart(2, '0');
      return '#' + [0, 2, 4].map((i) => h(n(i) * (1 - amount) + o(i) * amount)).join('');
    };
    const contrastRatio = (one, two) => {
      const lum = (hex) => {
        const c = hex.replace('#', '');
        const channels = [0, 2, 4].map((i) => {
          const value = parseInt(c.slice(i, i + 2), 16) / 255;
          return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const lighter = Math.max(lum(one), lum(two));
      const darker = Math.min(lum(one), lum(two));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const bestForeground = (background) => contrastRatio('#ffffff', background) >= contrastRatio('#000000', background) ? '#ffffff' : '#000000';
    const readableForeground = (background, preferred) => contrastRatio(preferred, background) >= 4.5 ? preferred : bestForeground(background);
    const vars = (() => {
      const bg = isDark ? mix(config.backgroundColor, '#000000', 0.82) : config.backgroundColor;
      const fg = isDark ? mix(config.foregroundColor, '#ffffff', 0.78) : config.foregroundColor;
      const accent = isDark ? mix(config.accentColor, '#ffffff', 0.18) : config.accentColor;
      const card = isDark ? mix(bg, '#ffffff', 0.07) : mix(bg, '#ffffff', 0.28);
      const muted = isDark ? mix(bg, '#ffffff', 0.12) : mix(bg, fg, 0.06);
      const border = isDark ? mix(bg, '#ffffff', 0.24) : mix(bg, fg, 0.14);
      const primaryForeground = bestForeground(accent);
      const secondaryForeground = readableForeground(muted, fg);
      const mutedForeground = readableForeground(muted, isDark ? mix(fg, bg, 0.18) : mix(fg, bg, 0.2));
      const resolvedAccent = isDark ? mix(accent, bg, 0.48) : mix(accent, bg, 0.62);
      const accentForeground = readableForeground(resolvedAccent, fg);
      return {
        '--background': bg,
        '--foreground': fg,
        '--card': card,
        '--card-foreground': fg,
        '--popover': card,
        '--popover-foreground': fg,
        '--primary': accent,
        '--primary-foreground': primaryForeground,
        '--secondary': muted,
        '--secondary-foreground': secondaryForeground,
        '--muted': muted,
        '--muted-foreground': mutedForeground,
        '--accent': resolvedAccent,
        '--accent-foreground': accentForeground,
        '--border': border,
        '--input': border,
        '--ring': accent,
        '--sidebar': isDark ? mix(bg, '#000000', 0.16) : mix(bg, '#ffffff', 0.55),
        '--sidebar-foreground': fg,
        '--sidebar-primary': accent,
        '--sidebar-primary-foreground': primaryForeground,
        '--sidebar-accent': muted,
        '--sidebar-accent-foreground': secondaryForeground,
        '--sidebar-border': border,
        '--sidebar-ring': accent,
        '--app-font-sans': ${JSON.stringify(UI_FONT_STACKS)}[config.uiFont] || ${JSON.stringify(UI_FONT_STACKS.system)},
        '--app-font-mono': ${JSON.stringify(CODE_FONT_STACKS)}[config.codeFont] || ${JSON.stringify(CODE_FONT_STACKS['system-mono'])},
      };
    })();
    Object.entries(vars).forEach(([key, value]) => style.setProperty(key, value));
  } catch {
    document.documentElement.classList.remove('${DARK_CLASS_NAME}');
  }
})();`

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'auto'
}

function isTemplateId(value: unknown): value is AppearanceTemplateId {
  return APPEARANCE_TEMPLATES.some((template) => template.id === value)
}

function isAppearanceFont(value: unknown): value is AppearanceFont {
  return value === 'geist' || value === 'system' || value === 'inter' || value === 'serif'
}

function isAppearanceCodeFont(value: unknown): value is AppearanceCodeFont {
  return value === 'geist-mono' || value === 'system-mono' || value === 'jetbrains' || value === 'sf-mono'
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

export function getDefaultAppearanceConfig(): AppearanceConfig {
  return { ...DEFAULT_APPEARANCE }
}

export function hasDefaultAppearanceValues(config: AppearanceConfig): boolean {
  return config.version === DEFAULT_APPEARANCE.version &&
    config.mode === DEFAULT_APPEARANCE.mode &&
    config.accentColor === DEFAULT_APPEARANCE.accentColor &&
    config.backgroundColor === DEFAULT_APPEARANCE.backgroundColor &&
    config.foregroundColor === DEFAULT_APPEARANCE.foregroundColor &&
    config.uiFont === DEFAULT_APPEARANCE.uiFont &&
    config.codeFont === DEFAULT_APPEARANCE.codeFont &&
    config.templateId === DEFAULT_APPEARANCE.templateId
}

export function normalizeAppearanceConfig(value: unknown): AppearanceConfig {
  if (isThemePreference(value)) {
    return { ...DEFAULT_APPEARANCE, mode: value }
  }

  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_APPEARANCE }
  }

  const input = value as Partial<AppearanceConfig>
  if (input.customApplied !== true) {
    return { ...DEFAULT_APPEARANCE }
  }

  const normalized: AppearanceConfig = {
    version: 1,
    mode: isThemePreference(input.mode) ? input.mode : DEFAULT_APPEARANCE.mode,
    accentColor: isHexColor(input.accentColor) ? input.accentColor : DEFAULT_APPEARANCE.accentColor,
    backgroundColor: isHexColor(input.backgroundColor) ? input.backgroundColor : DEFAULT_APPEARANCE.backgroundColor,
    foregroundColor: isHexColor(input.foregroundColor) ? input.foregroundColor : DEFAULT_APPEARANCE.foregroundColor,
    uiFont: isAppearanceFont(input.uiFont) ? input.uiFont : DEFAULT_APPEARANCE.uiFont,
    codeFont: isAppearanceCodeFont(input.codeFont) ? input.codeFont : DEFAULT_APPEARANCE.codeFont,
    templateId: isTemplateId(input.templateId) ? input.templateId : DEFAULT_APPEARANCE.templateId,
    customApplied: true,
  }

  return hasDefaultAppearanceValues(normalized) ? { ...DEFAULT_APPEARANCE } : normalized
}

export function readStoredAppearanceConfig(): AppearanceConfig {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_APPEARANCE }
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (!stored) return { ...DEFAULT_APPEARANCE }
    const normalized = isThemePreference(stored)
      ? normalizeAppearanceConfig(stored)
      : normalizeAppearanceConfig(JSON.parse(stored))
    if (hasDefaultAppearanceValues(normalized)) {
      window.localStorage.removeItem(THEME_STORAGE_KEY)
    }
    return normalized
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}


function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) as [number, number, number]
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`
}

export function mixColor(color: string, other: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(color)
  const [r2, g2, b2] = hexToRgb(other)
  return rgbToHex([
    r1 * (1 - amount) + r2 * amount,
    g1 * (1 - amount) + g2 * amount,
    b1 * (1 - amount) + b2 * amount,
  ])
}

export function getContrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = hexToRgb(hex).map((channel) => {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

export function getBestContrastingForeground(background: string): '#000000' | '#ffffff' {
  return getContrastRatio('#ffffff', background) >= getContrastRatio('#000000', background) ? '#ffffff' : '#000000'
}

function getReadableForeground(background: string, preferred: string): string {
  return getContrastRatio(preferred, background) >= 4.5 ? preferred : getBestContrastingForeground(background)
}

export function resolveAppearanceIsDark(mode: ThemePreference): boolean {
  return mode === 'dark' || (mode === 'auto' && getSystemPrefersDark())
}

export function resolveAppearanceCssVariables(config: AppearanceConfig, isDark: boolean): AppearanceCssVariables {
  const bg = isDark ? mixColor(config.backgroundColor, '#000000', 0.82) : config.backgroundColor
  const fg = isDark ? mixColor(config.foregroundColor, '#ffffff', 0.78) : config.foregroundColor
  const accent = isDark ? mixColor(config.accentColor, '#ffffff', 0.18) : config.accentColor
  const card = isDark ? mixColor(bg, '#ffffff', 0.07) : mixColor(bg, '#ffffff', 0.28)
  const muted = isDark ? mixColor(bg, '#ffffff', 0.12) : mixColor(bg, fg, 0.06)
  const border = isDark ? mixColor(bg, '#ffffff', 0.24) : mixColor(bg, fg, 0.14)
  const primaryForeground = getBestContrastingForeground(accent)
  const secondaryForeground = getReadableForeground(muted, fg)
  const mutedForeground = getReadableForeground(muted, isDark ? mixColor(fg, bg, 0.18) : mixColor(fg, bg, 0.2))
  const resolvedAccent = isDark ? mixColor(accent, bg, 0.48) : mixColor(accent, bg, 0.62)
  const accentForeground = getReadableForeground(resolvedAccent, fg)

  return {
    '--background': bg,
    '--foreground': fg,
    '--card': card,
    '--card-foreground': fg,
    '--popover': card,
    '--popover-foreground': fg,
    '--primary': accent,
    '--primary-foreground': primaryForeground,
    '--secondary': muted,
    '--secondary-foreground': secondaryForeground,
    '--muted': muted,
    '--muted-foreground': mutedForeground,
    '--accent': resolvedAccent,
    '--accent-foreground': accentForeground,
    '--border': border,
    '--input': border,
    '--ring': accent,
    '--sidebar': isDark ? mixColor(bg, '#000000', 0.16) : mixColor(bg, '#ffffff', 0.55),
    '--sidebar-foreground': fg,
    '--sidebar-primary': accent,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': muted,
    '--sidebar-accent-foreground': secondaryForeground,
    '--sidebar-border': border,
    '--sidebar-ring': accent,
    '--app-font-sans': UI_FONT_STACKS[config.uiFont],
    '--app-font-mono': CODE_FONT_STACKS[config.codeFont],
  }
}

function applyDarkClass(isDark: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(DARK_CLASS_NAME, isDark)
}

function clearAppearanceVariables(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement.style
  for (const variable of CUSTOM_APPEARANCE_VARIABLES) {
    root.removeProperty(variable)
  }
}

function applyAppearanceVariables(config: AppearanceConfig, isDark: boolean): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement.style
  const variables = resolveAppearanceCssVariables(config, isDark)
  for (const [name, value] of Object.entries(variables)) {
    root.setProperty(name, value)
  }
}

function clearSystemThemeListener(): void {
  if (!removeSystemThemeListener) return
  removeSystemThemeListener()
  removeSystemThemeListener = null
}

function getSystemPrefersDark(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches
}

function resolveIsDark(mode: ThemePreference): boolean {
  return resolveAppearanceIsDark(mode)
}

function applyThemeModeOnly(mode: ThemePreference): void {
  clearSystemThemeListener()
  clearAppearanceVariables()

  if (mode === 'auto') {
    attachSystemThemeListener({ ...DEFAULT_APPEARANCE, mode, customApplied: false })
    return
  }

  applyDarkClass(resolveIsDark(mode))
}

function attachSystemThemeListener(config: AppearanceConfig): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    applyDarkClass(false)
    if (config.customApplied) applyAppearanceVariables(config, false)
    else clearAppearanceVariables()
    return
  }

  const mediaQuery = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY)
  const applyCurrentSystemTheme = (): void => {
    applyDarkClass(mediaQuery.matches)
    if (config.customApplied) applyAppearanceVariables(config, mediaQuery.matches)
    else clearAppearanceVariables()
  }

  applyCurrentSystemTheme()
  const handleChange = (): void => {
    applyCurrentSystemTheme()
  }

  mediaQuery.addEventListener('change', handleChange)
  removeSystemThemeListener = () => {
    mediaQuery.removeEventListener('change', handleChange)
  }
}

export function applyAppearanceConfig(
  config: AppearanceConfig,
  options: { persist?: boolean; applyModeWhenCustomDisabled?: boolean } = {},
): void {
  if (typeof window === 'undefined') return

  const normalized = normalizeAppearanceConfig(config)
  const { persist = true, applyModeWhenCustomDisabled = false } = options

  if (persist) {
    try {
      if (hasDefaultAppearanceValues(normalized)) {
        window.localStorage.removeItem(THEME_STORAGE_KEY)
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(normalized))
      }
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }

  if (!normalized.customApplied) {
    if (applyModeWhenCustomDisabled) {
      applyThemeModeOnly(normalized.mode)
    } else {
      clearSystemThemeListener()
      clearAppearanceVariables()
    }
    return
  }

  clearSystemThemeListener()

  if (normalized.mode === 'auto') {
    attachSystemThemeListener(normalized)
    return
  }

  const isDark = resolveIsDark(normalized.mode)
  applyDarkClass(isDark)
  if (normalized.customApplied) {
    applyAppearanceVariables(normalized, isDark)
  } else {
    clearAppearanceVariables()
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean } = {},
): void {
  if (typeof window === 'undefined') return

  const { persist = true } = options
  if (persist) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {
      // Ignore localStorage write failures in restricted environments.
    }
  }
  applyThemeModeOnly(preference)
}

export function initializeThemePreference(): ThemePreference {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
      if (isThemePreference(stored)) {
        applyThemeModeOnly(stored)
        return stored
      }
    } catch {
      // Fall through to normalized defaults.
    }
  }

  const config = readStoredAppearanceConfig()
  applyAppearanceConfig(config, {
    persist: false,
    applyModeWhenCustomDisabled: hasDefaultAppearanceValues(config),
  })
  return config.mode
}

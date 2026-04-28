export type UiWebBaseMode = 'auto' | 'same-origin'
export type DefaultSurface = 'builder' | 'collab'

const DEFAULT_WEB_BASE_MODE: UiWebBaseMode = 'auto'
const DEFAULT_SURFACE: DefaultSurface = 'builder'

export function parseUiWebBaseMode(rawValue?: string): UiWebBaseMode {
  const normalized = rawValue?.trim().toLowerCase()
  if (normalized === 'same-origin') {
    return 'same-origin'
  }

  return DEFAULT_WEB_BASE_MODE
}

export function parseDefaultSurface(rawValue?: string): DefaultSurface {
  const normalized = rawValue?.trim().toLowerCase()
  if (normalized === 'collab') {
    return 'collab'
  }

  return DEFAULT_SURFACE
}

export function getConfiguredUiWebBaseMode(): UiWebBaseMode {
  return parseUiWebBaseMode(
    (import.meta.env.VITE_FORGE_WEB_BASE as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_WEB_BASE as string | undefined),
  )
}

export function getConfiguredDefaultSurface(): DefaultSurface {
  return parseDefaultSurface(
    (import.meta.env.VITE_FORGE_DEFAULT_SURFACE as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_DEFAULT_SURFACE as string | undefined),
  )
}

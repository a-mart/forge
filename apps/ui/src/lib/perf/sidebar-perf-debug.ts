/**
 * Sidebar perf — frontend debug-enable contract.
 *
 * Single source of truth for the debug toggle. The plan calls for ONE
 * explicit browser-side toggle so call sites do not invent ad-hoc query-param
 * or env-var checks.
 *
 * Source of truth (read at the call site):
 *   localStorage['forge:sidebarPerfDebug'] === '1'
 *
 * The flag only gates Profiler-based metrics (`sidebar.commit_ms` and
 * `sidebar.renders_per_ws_event`) — those are wired in Package 5. The
 * always-on session-switch metrics (`session_switch.click_to_*`) do not
 * consult this flag because their cost is negligible.
 *
 * The console helpers exposed here let users dump the live registry from
 * devtools without enabling debug mode (e.g. `window.__forgePerf.sidebar.dump()`).
 *
 * See `.internal/sidebar-perf/instrumentation-plan.md` Section 3 ("Frontend
 * debug-enable contract").
 */

import {
  createSidebarPerfRegistry,
  type SidebarPerfRegistry,
} from './sidebar-perf-registry'

const DEBUG_FLAG_KEY = 'forge:sidebarPerfDebug'
const DEBUG_FLAG_VALUE = '1'

let registrySingleton: SidebarPerfRegistry | null = null

/**
 * Returns the process-wide perf registry. Lazily constructed so SSR / tests
 * that do not touch perf paths pay nothing.
 */
export function getSidebarPerfRegistry(): SidebarPerfRegistry {
  if (!registrySingleton) {
    registrySingleton = createSidebarPerfRegistry()
  }
  return registrySingleton
}

/**
 * Reads the single debug-enable flag. Safe to call on SSR / Node — returns
 * `false` when no `localStorage` is available.
 */
export function isSidebarPerfDebugEnabled(): boolean {
  try {
    if (typeof globalThis === 'undefined') {
      return false
    }
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    if (!storage) {
      return false
    }
    return storage.getItem(DEBUG_FLAG_KEY) === DEBUG_FLAG_VALUE
  } catch {
    return false
  }
}

interface ForgePerfSidebarSurface {
  enableDebug: () => void
  disableDebug: () => void
  isDebugEnabled: () => boolean
  summary: () => unknown
  dump: () => unknown
}

interface ForgePerfWindow {
  __forgePerf?: Record<string, unknown> & { sidebar?: ForgePerfSidebarSurface }
}

let installed = false

/**
 * Installs the `window.__forgePerf.sidebar.*` console helpers exactly once.
 * Idempotent and a no-op in non-browser contexts.
 */
export function installSidebarPerfDebugHooks(): void {
  if (installed) {
    return
  }
  if (typeof globalThis === 'undefined') {
    return
  }
  const win = globalThis as ForgePerfWindow & {
    localStorage?: Storage
    location?: { reload: () => void }
  }
  if (!win.localStorage) {
    return
  }

  const sidebarSurface: ForgePerfSidebarSurface = {
    enableDebug: () => {
      try {
        win.localStorage?.setItem(DEBUG_FLAG_KEY, DEBUG_FLAG_VALUE)
        console.info(
          '[forge-perf] sidebar perf debug enabled — reload to activate Profiler-based counters.',
        )
      } catch {
        /* ignore */
      }
    },
    disableDebug: () => {
      try {
        win.localStorage?.removeItem(DEBUG_FLAG_KEY)
        console.info('[forge-perf] sidebar perf debug disabled — reload to take effect.')
      } catch {
        /* ignore */
      }
    },
    isDebugEnabled: isSidebarPerfDebugEnabled,
    summary: () => getSidebarPerfRegistry().readSummary(),
    dump: () => {
      const summary = getSidebarPerfRegistry().readSummary()
      try {
        console.groupCollapsed('[forge-perf] sidebar perf dump')
        console.log('summary', summary)
        if (typeof console.table === 'function') {
          const histogramRows = Object.entries(summary.histograms).map(([name, h]) => ({
            metric: name,
            count: h.count,
            mean_ms: round(h.mean),
            p50_ms: round(h.p50),
            p95_ms: round(h.p95),
            max_ms: round(h.max),
          }))
          if (histogramRows.length > 0) {
            console.table(histogramRows)
          }
        }
        console.log('recentSlowEvents', summary.recentSlowEvents)
        console.groupEnd()
      } catch {
        /* ignore */
      }
      return summary
    },
  }

  // Merge into existing namespace to avoid clobbering other perf surfaces.
  win.__forgePerf = { ...win.__forgePerf, sidebar: sidebarSurface }
  installed = true
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

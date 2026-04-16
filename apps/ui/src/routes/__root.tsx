/* eslint-disable react-refresh/only-export-components -- TanStack route file must export Route alongside components */
import { useEffect } from 'react'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HelpProvider } from '@/components/help/HelpProvider'
import { HelpDrawer } from '@/components/help/HelpDrawer'
import { GuidedTour } from '@/components/help/GuidedTour'
import { ShortcutOverlay } from '@/components/help/ShortcutOverlay'
import { useHelpHotkeys } from '@/components/help/help-hooks'
import { initializeHelpContent } from '@/components/help/help-registry'
import { isElectron } from '@/lib/electron-bridge'
import { preloadBuiltInSounds } from '@/lib/notification-service'
import { installSidebarPerfDebugHooks } from '@/lib/perf/sidebar-perf-debug'
import { THEME_INIT_SCRIPT, initializeThemePreference } from '@/lib/theme'
import { useTitleBarOverlay } from '@/lib/use-title-bar-overlay'
import { IndexPage } from './index'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no',
      },
      {
        title: 'Forge',
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%A8%3C/text%3E%3C/svg%3E",
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  notFoundComponent: IndexPage,
  shellComponent: RootDocument,
})

// Initialize help content eagerly so it's available before any render
initializeHelpContent()

/**
 * Thin wrapper so useHelpHotkeys() is called inside HelpProvider.
 */
function HelpHotkeysRegistrar() {
  useHelpHotkeys()
  return null
}

function RootDocument({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initializeThemePreference()
    preloadBuiltInSounds()
    // Install window.__forgePerf console helpers so users can dump sidebar
    // perf samples from devtools without enabling debug mode.
    installSidebarPerfDebugHooks()
  }, [])

  useTitleBarOverlay()

  const showTanStackDevtools = import.meta.env.VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS !== 'true'

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="overflow-hidden">
        <TooltipProvider>
          <HelpProvider>
            <HelpHotkeysRegistrar />
            {children}
            <HelpDrawer />
            <GuidedTour />
            <ShortcutOverlay />
            {showTanStackDevtools && import.meta.env.DEV && !isElectron() ? (
              <TanStackDevtools
                config={{
                  position: 'bottom-right',
                }}
                plugins={[
                  {
                    name: 'Tanstack Router',
                    render: <TanStackRouterDevtoolsPanel />,
                  },
                ]}
              />
            ) : null}
          </HelpProvider>
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  )
}

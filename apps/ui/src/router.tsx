import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// React's development build records a User Timing measure for every component
// render. Browsers retain those entries until cleared, so a long-lived dev
// renderer grows until it crashes. Forge never reads them; DevTools traces
// capture measures as they are recorded and are unaffected.
if (import.meta.env.DEV && typeof performance !== 'undefined' && typeof window !== 'undefined') {
  const clearMeasuresTimer = window.setInterval(() => performance.clearMeasures(), 10_000)
  import.meta.hot?.dispose(() => window.clearInterval(clearMeasuresTimer))
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,

    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

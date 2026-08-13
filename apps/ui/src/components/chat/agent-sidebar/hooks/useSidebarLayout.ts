import { useEffect, useState } from 'react'
import { readSidebarLayoutPref, type SidebarLayout } from '@/lib/sidebar-prefs'

const SIDEBAR_PREF_CHANGE_EVENT = 'forge-sidebar-pref-change'

/** Keeps sibling sidebar surfaces in sync with the presentation-only layout preference. */
export function useSidebarLayout(): SidebarLayout {
  const [sidebarLayout, setSidebarLayout] = useState<SidebarLayout>(() => readSidebarLayoutPref())

  useEffect(() => {
    const update = () => setSidebarLayout(readSidebarLayoutPref())
    window.addEventListener(SIDEBAR_PREF_CHANGE_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(SIDEBAR_PREF_CHANGE_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])

  return sidebarLayout
}

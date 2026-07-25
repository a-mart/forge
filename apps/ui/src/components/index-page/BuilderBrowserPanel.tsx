import type { ComponentProps } from 'react'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import type { ManagerWsClient } from '@/lib/ws-client'

type Props = Omit<ComponentProps<typeof BrowserPanel>, 'client'> & {
  client: ManagerWsClient | null
}

/** Builder-owned wiring boundary for canonical browser mutations. */
export function BuilderBrowserPanel(props: Props) {
  return <BrowserPanel {...props} />
}

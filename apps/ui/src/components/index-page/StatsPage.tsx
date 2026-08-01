import { StatsPanel } from '@/components/stats/StatsPanel'
import { TokenAnalyticsPanel } from '@/components/stats/token-analytics/TokenAnalyticsPanel'
import { GenerationThroughputPanel } from '@/components/stats/generation-throughput/GenerationThroughputPanel'
import type { StatsTab } from '@/hooks/index-page/use-route-state'

interface StatsPageProps {
  wsUrl: string
  routeState: { view: 'stats'; statsTab?: StatsTab }
  onBack: () => void
  onTabChange: (tab: StatsTab) => void
}

export function StatsPage({ wsUrl, routeState, onBack, onTabChange }: StatsPageProps) {
  const tab = routeState.statsTab ?? 'overview'

  if (tab === 'throughput') {
    return (
      <GenerationThroughputPanel
        wsUrl={wsUrl}
        onBack={onBack}
        activeTab={tab}
        onTabChange={onTabChange}
      />
    )
  }

  if (tab === 'tokens') {
    return (
      <TokenAnalyticsPanel
        wsUrl={wsUrl}
        onBack={onBack}
        activeTab={tab}
        onTabChange={onTabChange}
      />
    )
  }

  return (
    <StatsPanel
      wsUrl={wsUrl}
      onBack={onBack}
      activeTab={tab}
      onTabChange={onTabChange}
    />
  )
}

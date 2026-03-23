import { StatCard } from './StatCard'
import { abbreviateNumber, formatTokenCount } from '../charts/chart-utils'
import type { TokenStats, CacheStats } from '../stats-types'

interface TokenUsageCardsProps {
  tokens: TokenStats
  cache: CacheStats
}

export function TokenUsageCards({ tokens, cache }: TokenUsageCardsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Today"
        value={abbreviateNumber(tokens.today)}
        unit="tokens"
        subtitle={`${tokens.todayDate} · ${formatTokenCount(tokens.todayInputTokens)} in / ${formatTokenCount(tokens.todayOutputTokens)} out`}
        variant="accent"
      />
      <StatCard
        title="Last 7 Days"
        value={abbreviateNumber(tokens.last7Days)}
        unit="tokens"
        subtitle={`Avg ${abbreviateNumber(tokens.last7DaysAvgPerDay)}/day`}
        variant="accent"
      />
      <StatCard
        title="Last 30 Days"
        value={abbreviateNumber(tokens.last30Days)}
        unit="tokens"
        subtitle={`Total ${formatTokenCount(tokens.last30DaysTotal)}`}
        variant="accent"
      />
      <StatCard
        title="Cache Hit Rate"
        value={`${cache.hitRate.toFixed(1)}`}
        unit="%"
        subtitle={cache.hitRatePeriod}
        variant="accent"
      />
    </div>
  )
}

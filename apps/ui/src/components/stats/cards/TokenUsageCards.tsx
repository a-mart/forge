import { StatCard } from './StatCard'
import { abbreviateNumber, formatTokenCount } from '../charts/chart-utils'
import type { TokenStats, CacheStats } from '@forge/protocol'

interface TokenUsageCardsProps {
  tokens: TokenStats
  cache: CacheStats
}

export function TokenUsageCards({ tokens, cache }: TokenUsageCardsProps) {
  const avgPerDayLast30 = Math.round(tokens.last30Days / 30)
  const avgPerWeekLast30 = Math.round(tokens.last30Days * 7 / 30)

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Today"
        value={abbreviateNumber(tokens.today)}
        unit="tokens"
        subtitle={
          <div>
            {tokens.todayDate}
            <div>{formatTokenCount(tokens.todayInputTokens)} in</div>
            <div>{formatTokenCount(tokens.todayOutputTokens)} out</div>
          </div>
        }
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
        subtitle={`Avg ${abbreviateNumber(avgPerDayLast30)}/day · Avg ${abbreviateNumber(avgPerWeekLast30)}/week`}
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

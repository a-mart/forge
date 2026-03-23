import { StatCard } from './StatCard'
import { abbreviateNumber, formatTokenCount } from '../charts/chart-utils'
import type { TokenStats } from '@forge/protocol'

interface TokenUsageCardsProps {
  tokens: TokenStats
}

export function TokenUsageCards({ tokens }: TokenUsageCardsProps) {
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
        subtitle={
          <div>
            <div>Avg {abbreviateNumber(avgPerDayLast30)}/day</div>
            <div>Avg {abbreviateNumber(avgPerWeekLast30)}/week</div>
          </div>
        }
        variant="accent"
      />
      <StatCard
        title="All Time"
        value={abbreviateNumber(tokens.allTime)}
        unit="tokens"
        subtitle={`Total ${formatTokenCount(tokens.allTime)}`}
        variant="accent"
      />
    </div>
  )
}

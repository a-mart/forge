import { StatCard } from './StatCard'
import { abbreviateNumber } from '../charts/chart-utils'
import type { TokenStats } from '@forge/protocol'

interface TokenUsageCardsProps {
  tokens: TokenStats
}

export function TokenUsageCards({ tokens }: TokenUsageCardsProps) {
  const avgPerDayLast30 = Math.round(tokens.last30Days / 30)
  const avgPerWeekLast30 = Math.round(tokens.last30Days * 7 / 30)

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard
        title="Today"
        value={abbreviateNumber(tokens.today)}
        unit="tokens"
        subtitle={
          <div>
            <div>{abbreviateNumber(tokens.todayInputTokens)} in</div>
            <div>{abbreviateNumber(tokens.todayOutputTokens)} out</div>
          </div>
        }
        variant="accent"
      />
      <StatCard
        title="Yesterday"
        value={abbreviateNumber(tokens.yesterday)}
        unit="tokens"
        subtitle=""
        variant="accent"
      />
      <StatCard
        title="Last 7 Days"
        value={abbreviateNumber(tokens.last7Days)}
        unit="tokens"
        subtitle={`Avg ${abbreviateNumber(tokens.last7DaysAvgPerDay)} / day`}
        variant="accent"
      />
      <StatCard
        title="Last 30 Days"
        value={abbreviateNumber(tokens.last30Days)}
        unit="tokens"
        subtitle={
          <div>
            <div>Avg {abbreviateNumber(avgPerDayLast30)} / day</div>
            <div>Avg {abbreviateNumber(avgPerWeekLast30)} / week</div>
          </div>
        }
        variant="accent"
      />
      <StatCard
        title="All Time"
        value={abbreviateNumber(tokens.allTime)}
        unit="tokens"
        subtitle=""
        variant="accent"
      />
    </div>
  )
}

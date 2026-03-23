import { Card } from '@/components/ui/card'
import { StatCard } from '../cards/StatCard'
import type { ProviderUsageStats } from '@forge/protocol'

interface ProviderUsageProps {
  providers: ProviderUsageStats
}

function UsageMeter({
  title,
  percent,
  subtitle,
}: {
  title: string
  percent: number
  subtitle: string
}) {
  const clampedPercent = Math.min(percent, 100)
  const isHigh = percent >= 80

  return (
    <Card className="border-border/50 bg-card/80 p-4 backdrop-blur-sm">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="mt-1.5 font-mono text-2xl font-bold leading-none text-foreground">
        {percent}%
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isHigh ? 'bg-orange-500' : 'bg-primary'
          }`}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground/80">{subtitle}</div>
    </Card>
  )
}

export function ProviderUsage({ providers }: ProviderUsageProps) {
  const hasAnyProvider =
    (providers.anthropic?.available ?? false) || (providers.openai?.available ?? false)

  if (!hasAnyProvider) {
    return null
  }

  const openai = providers.openai
  const anthropic = providers.anthropic

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Account Limits
        </h3>
        {openai?.accountEmail ? (
          <span className="text-xs text-muted-foreground">
            {openai.accountEmail}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {openai?.available && openai.sessionUsage ? (
          <UsageMeter
            title="Session Usage"
            percent={openai.sessionUsage.percent}
            subtitle={openai.sessionUsage.resetInfo}
          />
        ) : null}
        {openai?.available && openai.weeklyUsage ? (
          <UsageMeter
            title="Weekly Usage"
            percent={openai.weeklyUsage.percent}
            subtitle={openai.weeklyUsage.resetInfo}
          />
        ) : null}
        {openai?.available && openai.plan ? (
          <StatCard
            title="Plan"
            value={openai.plan}
            subtitle="ChatGPT account"
          />
        ) : null}
        {anthropic?.available && anthropic.sessionUsage ? (
          <UsageMeter
            title="Anthropic Session"
            percent={anthropic.sessionUsage.percent}
            subtitle={anthropic.sessionUsage.resetInfo}
          />
        ) : null}
        {anthropic?.available && anthropic.weeklyUsage ? (
          <UsageMeter
            title="Anthropic Weekly"
            percent={anthropic.weeklyUsage.percent}
            subtitle={anthropic.weeklyUsage.resetInfo}
          />
        ) : null}
        {anthropic?.available && anthropic.plan ? (
          <StatCard
            title="Plan"
            value={anthropic.plan}
            subtitle="Anthropic account"
          />
        ) : null}
      </div>
    </div>
  )
}

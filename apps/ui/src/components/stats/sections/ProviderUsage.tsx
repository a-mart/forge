import { Card } from '@/components/ui/card'
import { StatCard } from '../cards/StatCard'
import type { ProviderAccountUsage, ProviderUsageStats } from '@forge/protocol'

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

function getOpenAIAccountHeading(account: ProviderAccountUsage, index: number, total: number): string {
  if (total <= 1) return 'OpenAI'
  return account.accountLabel || account.accountEmail || account.accountId || `Account ${index + 1}`
}

export function ProviderUsage({ providers }: ProviderUsageProps) {
  // Normalize: handle both old single-object and new array shape
  const openaiAccounts: ProviderAccountUsage[] = providers.openai
    ? (Array.isArray(providers.openai) ? providers.openai : [providers.openai as ProviderAccountUsage])
    : []
  const anthropic = providers.anthropic

  const hasAnyProvider =
    (anthropic?.available ?? false) || openaiAccounts.some((a) => a.available)

  if (!hasAnyProvider) {
    return null
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Account Limits
        </h3>
        {openaiAccounts.length === 1 && openaiAccounts[0].accountEmail ? (
          <span className="text-xs text-muted-foreground">
            {openaiAccounts[0].accountEmail}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {openaiAccounts.map((account, index) => {
          if (!account.available) return null
          const heading = openaiAccounts.length > 1
            ? getOpenAIAccountHeading(account, index, openaiAccounts.length)
            : undefined
          return (
            <OpenAIAccountCards key={account.accountId ?? index} account={account} heading={heading} />
          )
        })}
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

function OpenAIAccountCards({ account, heading }: { account: ProviderAccountUsage; heading?: string }) {
  const prefix = heading ? `${heading} — ` : ''
  return (
    <>
      {account.sessionUsage ? (
        <UsageMeter
          title={`${prefix}Session Usage`}
          percent={account.sessionUsage.percent}
          subtitle={account.sessionUsage.resetInfo}
        />
      ) : null}
      {account.weeklyUsage ? (
        <UsageMeter
          title={`${prefix}Weekly Usage`}
          percent={account.weeklyUsage.percent}
          subtitle={account.weeklyUsage.resetInfo}
        />
      ) : null}
      {account.plan ? (
        <StatCard
          title={heading ? `${heading} Plan` : 'Plan'}
          value={account.plan}
          subtitle={account.accountEmail ?? 'ChatGPT account'}
        />
      ) : null}
    </>
  )
}

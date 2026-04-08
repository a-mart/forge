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

function getAccountHeading(providerName: string, account: ProviderAccountUsage, index: number, total: number): string {
  if (total <= 1) return providerName
  return account.accountLabel || account.accountEmail || account.accountId || `Account ${index + 1}`
}

export function ProviderUsage({ providers }: ProviderUsageProps) {
  // Normalize: handle both old single-object and new array shape
  const openaiAccounts: ProviderAccountUsage[] = providers.openai
    ? (Array.isArray(providers.openai) ? providers.openai : [providers.openai as ProviderAccountUsage])
    : []
  const anthropicAccounts: ProviderAccountUsage[] = providers.anthropic
    ? (Array.isArray(providers.anthropic) ? providers.anthropic : [providers.anthropic as ProviderAccountUsage])
    : []

  const hasAnyProvider =
    anthropicAccounts.some((a) => a.available) || openaiAccounts.some((a) => a.available)

  if (!hasAnyProvider) {
    return null
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Account Limits
        </h3>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {anthropicAccounts.map((account, index) => {
          if (!account.available) return null
          const heading = anthropicAccounts.length > 1
            ? getAccountHeading('Anthropic', account, index, anthropicAccounts.length)
            : undefined
          return (
            <AccountCards key={`anthropic-${account.accountId ?? index}`} account={account} heading={heading} providerLabel="Anthropic" />
          )
        })}
        {openaiAccounts.map((account, index) => {
          if (!account.available) return null
          const heading = openaiAccounts.length > 1
            ? getAccountHeading('OpenAI', account, index, openaiAccounts.length)
            : undefined
          return (
            <AccountCards key={`openai-${account.accountId ?? index}`} account={account} heading={heading} providerLabel="OpenAI" />
          )
        })}
      </div>
    </div>
  )
}

function AccountCards({ account, heading, providerLabel }: { account: ProviderAccountUsage; heading?: string; providerLabel: string }) {
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
          subtitle={account.accountEmail ?? `${providerLabel} account`}
        />
      ) : null}
    </>
  )
}

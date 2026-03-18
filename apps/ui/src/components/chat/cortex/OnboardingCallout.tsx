import { Compass, PlayCircle, SkipForward, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { OnboardingStatus } from '@forge/protocol'
import { onboardingNeedsAttention, onboardingShowsPostSetupCta } from '@/lib/onboarding-ui'

interface OnboardingCalloutProps {
  status: OnboardingStatus
  hasProjectManagers: boolean
  isBusy?: boolean
  error?: string | null
  onSkipForNow?: () => void
  onCreateManager?: () => void
  onResumeOnboarding?: () => void
}

export function OnboardingCallout({
  status,
  hasProjectManagers,
  isBusy = false,
  error = null,
  onSkipForNow,
  onCreateManager,
  onResumeOnboarding,
}: OnboardingCalloutProps) {
  if (!(onboardingNeedsAttention(status) || onboardingShowsPostSetupCta(status))) {
    return null
  }

  const showSkipButton = onboardingNeedsAttention(status)
  const showCreateManager = onboardingShowsPostSetupCta(status) && !hasProjectManagers
  const showResume = status === 'deferred'

  return (
    <div className="border-b border-border/70 bg-background px-3 py-3 md:px-4">
      <Card className="gap-3 border-border/70 bg-muted/20 py-4 shadow-none">
        <CardHeader className="gap-1 px-4 pb-0">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <Sparkles className="size-3.5" />
            Cortex onboarding
          </div>
          <CardTitle className="text-sm font-semibold text-foreground">
            {onboardingNeedsAttention(status)
              ? 'Meet Cortex — it can learn your defaults so future managers start smarter.'
              : status === 'deferred'
                ? 'Ready when you are — create your first manager now or resume onboarding later.'
                : 'You’re ready to create your first manager.'}
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-3 px-4 pt-0">
          <p className="text-sm text-muted-foreground">
            {onboardingNeedsAttention(status)
              ? 'This is a lightweight first-launch chat. Cortex can capture a few cross-project preferences, or you can skip straight to work.'
              : status === 'deferred'
                ? 'Future managers will stay project-focused until you decide to add more personal defaults.'
                : 'Use the normal manager creation flow whenever you’re ready to start a project-specific session.'}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {showCreateManager ? (
              <Button type="button" size="sm" onClick={onCreateManager} disabled={isBusy}>
                <Compass className="mr-1.5 size-3.5" />
                Create your first manager
              </Button>
            ) : null}

            {showSkipButton ? (
              <Button type="button" size="sm" variant="outline" onClick={onSkipForNow} disabled={isBusy}>
                <SkipForward className="mr-1.5 size-3.5" />
                Skip for now
              </Button>
            ) : null}

            {showResume ? (
              <Button type="button" size="sm" variant="outline" onClick={onResumeOnboarding} disabled={isBusy}>
                <PlayCircle className="mr-1.5 size-3.5" />
                Resume onboarding
              </Button>
            ) : null}
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import type { OnboardingTechnicalLevel } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { OnboardingStateSummary, SaveOnboardingPreferencesInput } from '@/lib/onboarding-api'

interface OnboardingCalloutProps {
  mode: 'first-launch' | 'ready' | 'settings'
  state?: OnboardingStateSummary | null
  isBusy?: boolean
  error?: string | null
  success?: string | null
  onSave?: (input: SaveOnboardingPreferencesInput) => void | Promise<void>
  onSkipForNow?: () => void
  onCreateManager?: () => void
}

const TECHNICAL_LEVEL_OPTIONS: Array<{ value: OnboardingTechnicalLevel; label: string }> = [
  { value: 'developer', label: 'Developer' },
  { value: 'technical_non_developer', label: 'Technical (non-developer)' },
  { value: 'semi_technical', label: 'Semi-technical' },
  { value: 'non_technical', label: 'Non-technical' },
]

export function OnboardingCallout({
  mode,
  state = null,
  isBusy = false,
  error = null,
  success = null,
  onSave,
  onSkipForNow,
  onCreateManager,
}: OnboardingCalloutProps) {
  const [preferredName, setPreferredName] = useState(state?.preferences?.preferredName ?? '')
  const [technicalLevel, setTechnicalLevel] = useState<OnboardingTechnicalLevel | ''>(state?.preferences?.technicalLevel ?? '')
  const [additionalPreferences, setAdditionalPreferences] = useState(state?.preferences?.additionalPreferences ?? '')
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setPreferredName(state?.preferences?.preferredName ?? '')
    setTechnicalLevel(state?.preferences?.technicalLevel ?? '')
    setAdditionalPreferences(state?.preferences?.additionalPreferences ?? '')
    setValidationError(null)
  }, [state?.preferences?.additionalPreferences, state?.preferences?.preferredName, state?.preferences?.technicalLevel])

  const copy = useMemo(() => {
    switch (mode) {
      case 'settings':
        return {
          title: 'Welcome preferences',
          description: 'Update the basics future managers inherit across sessions.',
          submitLabel: 'Save preferences',
        }
      case 'ready':
        return {
          title: 'You’re ready to create your first manager',
          description: 'Your welcome preferences are set. Start a manager when you’re ready to begin.',
        }
      default:
        return {
          title: 'Welcome to Forge',
          description: 'Tell Forge a little about yourself so future managers can respond more naturally from the start.',
          submitLabel: 'Save & Continue',
        }
    }
  }, [mode])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedName = preferredName.trim()
    if (!trimmedName) {
      setValidationError('Name is required.')
      return
    }

    if (!technicalLevel) {
      setValidationError('Technical level is required.')
      return
    }

    setValidationError(null)
    void onSave?.({
      preferredName: trimmedName,
      technicalLevel,
      additionalPreferences: additionalPreferences.trim() || null,
    })
  }

  if (mode === 'ready') {
    return (
      <div className="px-3 py-6 md:px-4">
        <Card className="mx-auto max-w-2xl border-border/70">
          <CardHeader>
            <CardTitle>{copy.title}</CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={onCreateManager} disabled={isBusy}>
              Create your first manager
            </Button>
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className={mode === 'settings' ? '' : 'px-3 py-6 md:px-4'}>
      <Card className={mode === 'settings' ? 'border-border/70' : 'mx-auto max-w-2xl border-border/70'}>
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor={`onboarding-name-${mode}`}>Name</Label>
              <Input
                id={`onboarding-name-${mode}`}
                value={preferredName}
                onChange={(event) => setPreferredName(event.target.value)}
                placeholder="Your name"
                disabled={isBusy}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`onboarding-technical-level-${mode}`}>Technical Level</Label>
              <Select
                value={technicalLevel || undefined}
                onValueChange={(value) => setTechnicalLevel(value as OnboardingTechnicalLevel)}
                disabled={isBusy}
              >
                <SelectTrigger id={`onboarding-technical-level-${mode}`}>
                  <SelectValue placeholder="Select your technical level" />
                </SelectTrigger>
                <SelectContent>
                  {TECHNICAL_LEVEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`onboarding-additional-preferences-${mode}`}>Additional preferences</Label>
              <Textarea
                id={`onboarding-additional-preferences-${mode}`}
                value={additionalPreferences}
                onChange={(event) => setAdditionalPreferences(event.target.value)}
                placeholder="Any preferences for how you'd like responses? For example: concise vs detailed, how much explanation you want, etc."
                disabled={isBusy}
                rows={5}
              />
            </div>

            {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {success ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{success}</p> : null}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={isBusy}>
                {copy.submitLabel}
              </Button>
              {mode === 'first-launch' ? (
                <Button type="button" variant="outline" onClick={onSkipForNow} disabled={isBusy}>
                  Skip for now
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

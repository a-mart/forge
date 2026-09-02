import { useId, useState } from 'react'
import { RefreshCw, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  generatePassphrase,
  generateRandomPassword,
  type PassphraseOptions,
  type RandomPasswordOptions,
} from './password-generator-core'

export function PasswordGenerator({
  disabled = false,
  onGenerate,
}: {
  disabled?: boolean
  onGenerate: (value: string) => void
}) {
  const id = useId()
  const lengthId = `${id}-length`
  const wordsId = `${id}-words`
  const separatorId = `${id}-separator`
  const [mode, setMode] = useState<'password' | 'passphrase'>('password')
  const [passwordOptions, setPasswordOptions] = useState<RandomPasswordOptions>({
    length: 24,
    lowercase: true,
    uppercase: true,
    numbers: true,
    symbols: true,
    avoidAmbiguous: true,
  })
  const [phraseOptions, setPhraseOptions] = useState<PassphraseOptions>({
    wordCount: 8,
    separator: '-',
    capitalize: false,
    includeNumber: true,
  })
  const generate = () => onGenerate(
    mode === 'password'
      ? generateRandomPassword(passwordOptions)
      : generatePassphrase(phraseOptions),
  )
  const setCharacterOption = (
    key: 'lowercase' | 'uppercase' | 'numbers' | 'symbols',
    checked: boolean,
  ) => setPasswordOptions((current) => {
    if (!checked) {
      const remaining = ['lowercase', 'uppercase', 'numbers', 'symbols']
        .some((candidate) => candidate !== key && current[candidate as keyof RandomPasswordOptions])
      if (!remaining) return current
    }
    return { ...current, [key]: checked }
  })

  return (
    <details className="rounded-md border border-border/70 bg-muted/20 p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        <span className="inline-flex items-center gap-1.5">
          <WandSparkles className="size-3.5" aria-hidden="true" />
          Generate a password
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="flex gap-1 rounded-md bg-muted p-1">
          {(['password', 'passphrase'] as const).map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={mode === candidate ? 'secondary' : 'ghost'}
              className="flex-1 capitalize"
              disabled={disabled}
              onClick={() => setMode(candidate)}
            >
              {candidate}
            </Button>
          ))}
        </div>

        {mode === 'password' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor={lengthId}>Length</Label>
                <Input
                  id={lengthId}
                  type="number"
                  min={12}
                  max={128}
                  value={passwordOptions.length}
                  disabled={disabled}
                  onChange={(event) => setPasswordOptions((current) => ({
                    ...current,
                    length: Number(event.target.value),
                  }))}
                />
              </div>
              <input
                aria-label="Password length"
                type="range"
                min={12}
                max={128}
                value={passwordOptions.length}
                disabled={disabled}
                onChange={(event) => setPasswordOptions((current) => ({
                  ...current,
                  length: Number(event.target.value),
                }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              {([
                ['lowercase', 'Lowercase'],
                ['uppercase', 'Uppercase'],
                ['numbers', 'Numbers'],
                ['symbols', 'Symbols'],
                ['avoidAmbiguous', 'Avoid ambiguous'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={passwordOptions[key]}
                    disabled={disabled}
                    onChange={(event) => key === 'avoidAmbiguous'
                      ? setPasswordOptions((current) => ({
                          ...current,
                          avoidAmbiguous: event.target.checked,
                        }))
                      : setCharacterOption(key, event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={wordsId}>Words</Label>
                <Input
                  id={wordsId}
                  type="number"
                  min={4}
                  max={12}
                  value={phraseOptions.wordCount}
                  disabled={disabled}
                  onChange={(event) => setPhraseOptions((current) => ({
                    ...current,
                    wordCount: Number(event.target.value),
                  }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={separatorId}>Separator</Label>
                <Select
                  value={phraseOptions.separator}
                  disabled={disabled}
                  onValueChange={(separator) => setPhraseOptions((current) => ({
                    ...current,
                    separator,
                  }))}
                >
                  <SelectTrigger id={separatorId}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="-">Hyphen</SelectItem>
                    <SelectItem value="_">Underscore</SelectItem>
                    <SelectItem value=".">Period</SelectItem>
                    <SelectItem value=" ">Space</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={phraseOptions.capitalize}
                  disabled={disabled}
                  onChange={(event) => setPhraseOptions((current) => ({
                    ...current,
                    capitalize: event.target.checked,
                  }))}
                />
                Capitalize words
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={phraseOptions.includeNumber}
                  disabled={disabled}
                  onChange={(event) => setPhraseOptions((current) => ({
                    ...current,
                    includeNumber: event.target.checked,
                  }))}
                />
                Add number
              </label>
            </div>
          </>
        )}

        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={generate}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Generate / refresh
        </Button>
        <p className="text-xs text-muted-foreground">
          Generated locally in this window. Review or edit it before saving.
        </p>
      </div>
    </details>
  )
}

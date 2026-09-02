import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { PrivateValueTextarea } from '@/components/secure-session/PrivateValueTextarea'
import { PasswordGenerator } from '@/components/secure-session/PasswordGenerator'
import {
  secureSessionUiErrorMessage,
  SecureSessionUiError,
} from '@/lib/secure-sessions-api'
import { SECURE_SECRET_MAX_PROJECT_DEFAULTS } from '@forge/protocol'
import {
  formatSecureBinding,
  formatSecurePolicy,
} from './format'
import type {
  SecureLeasePolicyView,
  SecurePrivateFulfillmentInput,
  SecurePrivateDestinationOption,
  SecureSecretBindingView,
  SecureSessionProjectContext,
} from './types'

interface PrivateSecretValueDialogProps {
  alias?: string
  username?: string
  project: SecureSessionProjectContext
  requestedBindings: SecureSecretBindingView[]
  requestedPolicy: SecureLeasePolicyView
  onFulfill: (
    input: SecurePrivateFulfillmentInput,
  ) => void | Promise<void>
  onClose: () => void
  loadDestinations?: () => Promise<SecurePrivateDestinationOption[]>
}

type SavedScope = 'project' | 'instance'
type SubmitMode = 'saved' | 'session'

export function PrivateSecretValueDialog({
  alias,
  username: initialUsername,
  project,
  requestedBindings,
  requestedPolicy,
  onFulfill,
  onClose,
  loadDestinations,
}: PrivateSecretValueDialogProps) {
  const inputId = useId()
  const displayNameId = useId()
  const usernameId = useId()
  const projectScopeId = useId()
  const instanceScopeId = useId()
  const projectDefaultId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [privateValue, setPrivateValue] = useState('')
  const [hasValue, setHasValue] = useState(false)
  const [displayName, setDisplayName] = useState(alias ?? '')
  const [username, setUsername] = useState(initialUsername ?? '')
  const [savedScope, setSavedScope] = useState<SavedScope>('project')
  const [makeProjectDefault, setMakeProjectDefault] = useState(false)
  const [submitMode, setSubmitMode] = useState<SubmitMode | null>(null)
  const [destinations, setDestinations] = useState<SecurePrivateDestinationOption[]>([])
  const [destinationKey, setDestinationKey] = useState('local')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const selectedDestination = destinations.find(
    (option) => destinationOptionKey(option) === destinationKey,
  ) ?? (destinationKey === 'local' ? undefined : destinations[0])
  const projectDefaultLimitReached = project.projectDefaultLimitReached === true
  const maxProjectDefaults =
    project.maxProjectDefaults ?? SECURE_SECRET_MAX_PROJECT_DEFAULTS

  useEffect(() => {
    let active = true
    if (!loadDestinations) return () => { active = false }
    void loadDestinations().then((options) => {
      if (!active) return
      setDestinations(options)
      const preferred = options.find(
        ({ destination }) => destination.kind === 'bitwarden_password_manager',
      )
      if (preferred) setDestinationKey(destinationOptionKey(preferred))
    }).catch(() => undefined)
    return () => { active = false }
  }, [loadDestinations])

  const setPrivateInputRef = useCallback((input: HTMLTextAreaElement | null) => {
    if (!input && inputRef.current) inputRef.current.value = ''
    inputRef.current = input
  }, [])

  const clearPrivateInput = () => {
    if (inputRef.current) inputRef.current.value = ''
    setPrivateValue('')
    setHasValue(false)
  }

  const close = () => {
    clearPrivateInput()
    setErrorMessage(null)
    onClose()
  }

  const fulfill = async (mode: SubmitMode) => {
    if (submitMode) return
    let valueForFulfillment = privateValue
    if (!valueForFulfillment) return

    // Remove the plaintext from the DOM before handing it across the private
    // Electron bridge. A failed request requires deliberate re-entry.
    clearPrivateInput()
    setErrorMessage(null)
    setSubmitMode(mode)
    try {
      const fulfillment = mode === 'session'
        ? onFulfill({
          value: valueForFulfillment,
          retention: 'session',
          scope: { kind: 'profile', profileId: project.profileId },
        })
        : onFulfill({
          value: valueForFulfillment,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          ...(username.trim() ? { username: username.trim() } : {}),
          ...(destinationKey === 'local'
            ? {}
            : {
                destination: selectedDestination?.destination ?? { kind: 'local' },
              }),
          retention: 'saved',
          scope: savedScope === 'project'
            ? { kind: 'profile', profileId: project.profileId }
            : { kind: 'instance' },
          ...(makeProjectDefault && !projectDefaultLimitReached
            ? { makeProjectDefault: true }
            : {}),
        })
      if (fulfillment) await fulfillment
      valueForFulfillment = ''
      close()
    } catch (error) {
      valueForFulfillment = ''
      setSubmitMode(null)
      const nextStep =
        error instanceof SecureSessionUiError
        && error.code === 'SECURE_SECRET_ALIAS_CONFLICT'
          ? 'Close this dialog to choose the existing saved secret in this request.'
          : 'Re-enter the value to try again.'
      setErrorMessage(
        `${secureSessionUiErrorMessage(error)} ${nextStep}`,
      )
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void fulfill('saved')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitMode) close()
      }}
    >
      <DialogContent
        className="max-w-lg"
        hideClose
        onKeyDown={(event) => event.stopPropagation()}
      >
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add secret and approve</DialogTitle>
            <DialogDescription>
              The value is encrypted by the Forge desktop app and never added to
              chat. The agent receives only the requested secure delivery.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor={displayNameId}>Secret name</Label>
            <Input
              id={displayNameId}
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              maxLength={256}
              disabled={Boolean(submitMode)}
            />
            <p className="text-xs text-muted-foreground">
              Saved as <span className="font-mono">{alias ?? 'the requested alias'}</span>.
              The name is only for you and can be changed.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={usernameId}>Username (optional)</Label>
            <Input
              id={usernameId}
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              maxLength={512}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={Boolean(submitMode)}
            />
            <p className="text-xs text-muted-foreground">
              Visible to the agent as login metadata. The private value remains protected.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={inputId}>{alias ? `Value for ${alias}` : 'Private value'}</Label>
            <PrivateValueTextarea
              id={inputId}
              ref={setPrivateInputRef}
              value={privateValue}
              onValueChange={(value) => {
                setPrivateValue(value)
                setHasValue(value.length > 0)
              }}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={Boolean(submitMode)}
              autoFocus
            />
          </div>
          <PasswordGenerator
            disabled={Boolean(submitMode)}
            onGenerate={(value) => {
              setPrivateValue(value)
              setHasValue(true)
            }}
          />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Save to</legend>
            <label
              htmlFor={projectScopeId}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3"
            >
              <input
                id={projectScopeId}
                type="radio"
                name="secure-secret-scope"
                value="project"
                checked={savedScope === 'project'}
                onChange={() => setSavedScope('project')}
                disabled={Boolean(submitMode)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  Current project
                </span>
                <span className="block text-xs text-muted-foreground">
                  Available only in {project.displayName}
                </span>
              </span>
            </label>
            <label
              htmlFor={instanceScopeId}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3"
            >
              <input
                id={instanceScopeId}
                type="radio"
                name="secure-secret-scope"
                value="instance"
                checked={savedScope === 'instance'}
                onChange={() => setSavedScope('instance')}
                disabled={Boolean(submitMode)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">All projects</span>
                <span className="block text-xs text-muted-foreground">
                  Available for approval in every local Forge project
                </span>
              </span>
            </label>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="private-secret-storage">Store in</Label>
            <Select
              value={destinationKey}
              onValueChange={setDestinationKey}
              disabled={Boolean(submitMode)}
            >
              <SelectTrigger id="private-secret-storage" className="w-full">
                <span data-slot="select-value">
                  {destinationKey === 'local'
                    ? 'Local Forge vault'
                    : selectedDestination?.label ?? 'Choose storage'}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local Forge vault</SelectItem>
                {destinations.map((option) => (
                  <SelectItem key={destinationOptionKey(option)} value={destinationOptionKey(option)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {destinationKey === 'local'
                ? 'Stored in this computer’s operating-system credential vault.'
                : selectedDestination?.description}
            </p>
          </div>

          <label
            htmlFor={projectDefaultId}
            className="flex cursor-pointer items-start gap-2 rounded-md bg-muted/45 p-3"
          >
            <input
              id={projectDefaultId}
              type="checkbox"
              checked={makeProjectDefault && !projectDefaultLimitReached}
              onChange={(event) => setMakeProjectDefault(event.target.checked)}
              disabled={Boolean(submitMode) || projectDefaultLimitReached}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">
                Automatically available in {project.displayName}
              </span>
              <span className="block text-xs text-muted-foreground">
                {projectDefaultLimitReached
                  ? `This project already has ${maxProjectDefaults} automatic secrets. Remove one in Settings to enable another.`
                  : 'Each future Team Secure Mode in this project receives access until it stops.'}
              </span>
            </span>
          </label>

          <details className="rounded-md border border-border p-3 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Advanced delivery review
            </summary>
            <dl className="mt-2 space-y-1 text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">
                  {requestedBindings.length === 1 ? 'Delivery: ' : 'Deliveries: '}
                </dt>
                <dd className="inline">
                  {requestedBindings.map(formatSecureBinding).join(', ')}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Current approval: </dt>
                <dd className="inline">{formatSecurePolicy(requestedPolicy)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-muted-foreground">
              These values came from the agent&apos;s pending request and cannot
              be changed here.
            </p>
          </details>

          {errorMessage ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
              role="alert"
            >
              {errorMessage}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(submitMode)}
              onClick={close}
            >
              Cancel
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="secondary"
                disabled={!hasValue || Boolean(submitMode)}
                onClick={() => void fulfill('session')}
              >
                {submitMode === 'session' ? 'Approving…' : 'Use for this task only'}
              </Button>
              <Button type="submit" disabled={!hasValue || Boolean(submitMode)}>
                {submitMode === 'saved' ? 'Saving…' : 'Add secret and approve'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function destinationOptionKey(option: SecurePrivateDestinationOption): string {
  const destination = option.destination
  return destination.kind === 'local'
    ? 'local'
    : `${destination.providerId}:${destination.collectionId}`
}

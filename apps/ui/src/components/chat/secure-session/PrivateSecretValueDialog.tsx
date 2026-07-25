import {
  useCallback,
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
  SecureSecretBindingView,
  SecureSessionProjectContext,
} from './types'

interface PrivateSecretValueDialogProps {
  alias?: string
  project: SecureSessionProjectContext
  requestedBindings: SecureSecretBindingView[]
  requestedPolicy: SecureLeasePolicyView
  onFulfill: (
    input: SecurePrivateFulfillmentInput,
  ) => void | Promise<void>
  onClose: () => void
}

type SavedScope = 'project' | 'instance'
type SubmitMode = 'saved' | 'session'

export function PrivateSecretValueDialog({
  alias,
  project,
  requestedBindings,
  requestedPolicy,
  onFulfill,
  onClose,
}: PrivateSecretValueDialogProps) {
  const inputId = useId()
  const projectScopeId = useId()
  const instanceScopeId = useId()
  const projectDefaultId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [hasValue, setHasValue] = useState(false)
  const [savedScope, setSavedScope] = useState<SavedScope>('project')
  const [makeProjectDefault, setMakeProjectDefault] = useState(false)
  const [submitMode, setSubmitMode] = useState<SubmitMode | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const projectDefaultLimitReached = project.projectDefaultLimitReached === true

  const setPrivateInputRef = useCallback((input: HTMLInputElement | null) => {
    if (!input && inputRef.current) inputRef.current.value = ''
    inputRef.current = input
  }, [])

  const clearPrivateInput = () => {
    if (inputRef.current) inputRef.current.value = ''
    setHasValue(false)
  }

  const close = () => {
    clearPrivateInput()
    setErrorMessage(null)
    onClose()
  }

  const fulfill = async (mode: SubmitMode) => {
    if (submitMode) return
    let privateValue = inputRef.current?.value ?? ''
    if (!privateValue) return

    // Remove the plaintext from the DOM before handing it across the private
    // Electron bridge. A failed request requires deliberate re-entry.
    clearPrivateInput()
    setErrorMessage(null)
    setSubmitMode(mode)
    try {
      if (mode === 'session') {
        await onFulfill({
          value: privateValue,
          retention: 'session',
          scope: { kind: 'profile', profileId: project.profileId },
        })
      } else {
        await onFulfill({
          value: privateValue,
          retention: 'saved',
          scope: savedScope === 'project'
            ? { kind: 'profile', profileId: project.profileId }
            : { kind: 'instance' },
          ...(makeProjectDefault && !projectDefaultLimitReached
            ? { makeProjectDefault: true }
            : {}),
        })
      }
      privateValue = ''
      close()
    } catch (error) {
      privateValue = ''
      setSubmitMode(null)
      const nextStep =
        error instanceof SecureSessionUiError
        && error.code === 'SECURE_SECRET_ALIAS_CONFLICT'
          ? 'Close this dialog and approve the newly saved secret.'
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
            <Label htmlFor={inputId}>{alias ? `Value for ${alias}` : 'Private value'}</Label>
            <Input
              id={inputId}
              ref={setPrivateInputRef}
              type="password"
              onChange={(event) => setHasValue(event.currentTarget.value.length > 0)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={Boolean(submitMode)}
              autoFocus
            />
          </div>

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
                  ? `This project already has ${SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic secrets. Remove one in Settings to enable another.`
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

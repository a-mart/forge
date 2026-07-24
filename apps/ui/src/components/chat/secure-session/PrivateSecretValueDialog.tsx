import { useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
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

interface PrivateSecretValueDialogProps {
  alias?: string
  onFulfill: (value: string | Uint8Array) => void | Promise<void>
  onClose: () => void
}

export function PrivateSecretValueDialog({
  alias,
  onFulfill,
  onClose,
}: PrivateSecretValueDialogProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  const clearAndClose = (beforeHandoff = false) => {
    if (inputRef.current) inputRef.current.value = ''
    const clearReactState = () => {
      setValue('')
      onClose()
    }
    if (beforeHandoff) {
      flushSync(clearReactState)
    } else {
      clearReactState()
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value) return

    const privateValue = value
    clearAndClose(true)
    try {
      void Promise.resolve(onFulfill(privateValue)).catch(() => undefined)
    } catch {
      // The value is already cleared and unmounted even if the handoff fails synchronously.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) clearAndClose(false)
    }}>
      <DialogContent className="max-w-md" hideClose>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Provide an unsaved private value</DialogTitle>
            <DialogDescription>
              This value is passed directly to the pending secure request. It is not saved to
              chat or added to the secret catalog, but it remains available for the request&apos;s
              approved Secure Bash scope.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor={inputId}>{alias ? `Value for ${alias}` : 'Private value'}</Label>
            <Input
              id={inputId}
              ref={inputRef}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => clearAndClose(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value}>
              Approve and provide
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

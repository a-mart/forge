import { Button } from '@/components/ui/button'

interface CollaborationAuthErrorProps {
  message?: string
  /**
   * Optional callback when the user requests to sign in.
   *
   * When provided, the button invokes this callback instead of navigating.
   * When omitted, the button navigates to the builder Settings view within
   * the SPA so the user can reach the Collaboration sign-in form.
   */
  onSignIn?: () => void
}

export function CollaborationAuthError({ message, onSignIn }: CollaborationAuthErrorProps) {
  return (
    <div
      className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 flex flex-col gap-2"
      data-testid="collab-auth-error"
    >
      <span className="text-sm font-medium text-destructive">
        {message ?? 'Your session has ended or you do not have permission to access this area.'}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => {
          if (onSignIn) {
            onSignIn()
            return
          }
          // Navigate to builder settings within the SPA where the Collaboration
          // sign-in form is available.  Avoids leaving the SPA entirely.
          window.location.href = '/?view=settings'
        }}
      >
        Sign in again
      </Button>
    </div>
  )
}

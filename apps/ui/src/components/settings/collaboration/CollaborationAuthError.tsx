import { Button } from '@/components/ui/button'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

interface CollaborationAuthErrorProps {
  message?: string
}

export function CollaborationAuthError({ message }: CollaborationAuthErrorProps) {
  const signInUrl = new URL('/collaboration/login', resolveCollaborationApiBaseUrl()).toString()

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
          window.location.href = signInUrl
        }}
      >
        Sign in again
      </Button>
    </div>
  )
}

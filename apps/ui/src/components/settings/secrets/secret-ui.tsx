import { AlertTriangle, Check, LockKeyhole, Unplug } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type {
  SecureSecretSourceStatus,
} from '@/lib/secure-secrets-api'

const STATUS_LABELS: Record<SecureSecretSourceStatus, string> = {
  available: 'Available',
  locked: 'Locked',
  auth_required: 'Reconnect required',
  unreachable: 'Unreachable',
  missing: 'Missing',
  disabled: 'Disabled',
}

export function SourceStatusBadge({ status }: { status: SecureSecretSourceStatus }) {
  if (status === 'available') {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        <Check className="size-3" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  if (status === 'locked' || status === 'auth_required') {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        <LockKeyhole className="size-3" />
        {STATUS_LABELS[status]}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Unplug className="size-3" />
      {STATUS_LABELS[status]}
    </Badge>
  )
}

export function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-center">
      <AlertTriangle className="mx-auto mb-2 size-5 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

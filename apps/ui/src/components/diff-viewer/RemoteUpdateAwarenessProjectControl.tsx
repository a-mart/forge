import type { RemoteUpdateAwarenessProjectOverride, RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateRemoteUpdateAwarenessProjectOverride } from '@/components/settings/remote-update-awareness-api'
import { useState } from 'react'

export function RemoteUpdateAwarenessProjectControl({
  wsUrl,
  snapshot,
  onSnapshotChange,
}: {
  wsUrl: string
  snapshot: RemoteUpdateAwarenessProjectSnapshot
  onSnapshotChange: (snapshot: RemoteUpdateAwarenessProjectSnapshot) => void
}) {
  const [updating, setUpdating] = useState(false)
  const update = async (override: RemoteUpdateAwarenessProjectOverride) => {
    setUpdating(true)
    try {
      const response = await updateRemoteUpdateAwarenessProjectOverride(wsUrl, snapshot.projectId, override)
      onSnapshotChange({ ...snapshot, ...response.project })
    } finally {
      setUpdating(false)
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="Git monitoring shortcut">
      <span className="hidden lg:inline">Git monitoring</span>
      <Select value={snapshot.override} disabled={updating} onValueChange={(value) => void update(value as RemoteUpdateAwarenessProjectOverride)}>
        <SelectTrigger className="h-7 w-24 text-[11px]" aria-label="Git monitoring for this project"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Inherit</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

import { Card } from '@/components/ui/card'
import { Server, Clock, Users, Code } from 'lucide-react'
import type { SystemStats } from '../stats-types'

interface SystemInfoProps {
  system: SystemStats
}

function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground/60" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-foreground">{value}</span>
    </div>
  )
}

export function SystemInfo({ system }: SystemInfoProps) {
  return (
    <Card className="border-border/50 bg-card/60 p-4 backdrop-blur-sm">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        System
      </h3>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <InfoItem icon={Clock} label="Uptime" value={system.uptimeFormatted} />
        <InfoItem icon={Users} label="Profiles" value={String(system.totalProfiles)} />
        <InfoItem icon={Server} label="Version" value={system.serverVersion} />
        <InfoItem icon={Code} label="Node" value={system.nodeVersion} />
      </div>
    </Card>
  )
}

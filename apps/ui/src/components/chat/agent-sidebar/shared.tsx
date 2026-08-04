import { cn } from '@/lib/utils'
import { inferModelPreset } from '@/lib/model-preset'
import type { AgentDescriptor } from '@forge/protocol'

export type SidebarRoomAvatarTone = 'amber' | 'blue' | 'green' | 'neutral' | 'red' | 'violet'

const ROOM_AVATAR_TONES: readonly SidebarRoomAvatarTone[] = ['amber', 'blue', 'green', 'violet', 'neutral']

/** Stable, CSS-token-backed project tint without persisting presentation state. */
export function getSidebarRoomAvatarTone(key: string): SidebarRoomAvatarTone {
  if (!key) return 'neutral'
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash * 31) + key.charCodeAt(index)) | 0
  }
  return ROOM_AVATAR_TONES[Math.abs(hash) % ROOM_AVATAR_TONES.length] ?? 'neutral'
}

export function SidebarRoomAvatar({
  label,
  tone,
  toneKey,
  className,
}: {
  label: string
  tone?: SidebarRoomAvatarTone
  toneKey?: string
  className?: string
}) {
  const initial = label.trim().charAt(0).toLocaleUpperCase() || '?'
  const resolvedTone = tone ?? getSidebarRoomAvatarTone(toneKey ?? label)
  return (
    <span className={cn('sidebar-room-avatar', `sidebar-room-avatar--${resolvedTone}`, className)} aria-hidden="true">
      {initial}
    </span>
  )
}

export function CodexExternalThreadIcon({ className }: { className?: string }) {
  return (
    <img
      src="/agents/codex-logo.svg"
      alt=""
      aria-hidden="true"
      data-external-thread-icon="codex_app_server"
      className={cn('size-3 shrink-0 object-contain dark:invert', className)}
    />
  )
}

export function SidebarStreamingWorkerBadge({ count, roomsV2 = false }: { count: number; roomsV2?: boolean }) {
  return (
    <span
      className={cn(
        roomsV2
          ? 'sidebar-room-status-pill sidebar-room-status-pill--workers sidebar-room-glow'
          : 'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-transparent animate-[subtle-glow-pulse_2s_ease-in-out_infinite]',
      )}
      aria-label={`${count} worker${count !== 1 ? 's' : ''} active`}
    >
      <span className={roomsV2 ? 'sidebar-room-status-pill-text' : 'text-[8px] font-bold leading-none text-amber-500'}>
        {count}
      </span>
    </span>
  )
}

export function SidebarCompactionBadge({ roomsV2 = false }: { roomsV2?: boolean }) {
  return (
    <span
      className={cn(
        roomsV2
          ? 'sidebar-room-status-pill sidebar-room-status-pill--compacting sidebar-room-glow sidebar-room-compaction-glow'
          : 'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-violet-400 bg-transparent animate-[subtle-glow-pulse_2s_ease-in-out_infinite]',
      )}
      aria-label="Compacting context"
    >
      <span className={roomsV2 ? 'sidebar-room-status-pill-text' : 'text-[8px] font-bold leading-none text-violet-400'}>C</span>
    </span>
  )
}

export function SessionStatusDot({ running, isCli, roomsV2 = false }: { running: boolean; isCli?: boolean; roomsV2?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-full',
        roomsV2 ? 'size-1.5 sidebar-room-status-glyph' : 'size-1.5',
        roomsV2
          ? isCli
            ? running ? 'sidebar-room-status-cli-running' : 'sidebar-room-status-cli-idle'
            : running ? 'sidebar-room-status-running' : 'sidebar-room-status-idle'
          : isCli
            ? running ? 'bg-violet-500' : 'bg-violet-400/50'
            : running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      )}
      aria-label={isCli ? (running ? 'CLI session running' : 'CLI session idle') : (running ? 'Running' : 'Idle')}
    />
  )
}

export function SidebarModelIcon({ agent }: { agent: AgentDescriptor }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus' || provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70" />
  }

  if (preset === 'pi-codex' || preset === 'pi-5.4' || provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70 dark:invert" />
  }

  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" aria-hidden="true" />
}

export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  let searchFrom = 0
  while (searchFrom < lowerText.length) {
    const index = lowerText.indexOf(lowerQuery, searchFrom)
    if (index === -1) break

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index))
    }
    parts.push(
      <span key={index} className="rounded-sm bg-yellow-500/20">
        {text.slice(index, index + query.length)}
      </span>,
    )
    lastIndex = index + query.length
    searchFrom = lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

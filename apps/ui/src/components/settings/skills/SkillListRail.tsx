import { useMemo } from 'react'
import { Loader2, Search, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SkillSourceBadge } from './SkillSourceBadge'
import type { SkillInventoryEntry } from './skills-viewer-types'

interface SkillListRailProps {
  skills: SkillInventoryEntry[]
  isLoading: boolean
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedSkillId: string | null
  onSelectSkill: (skillId: string) => void
}

export function SkillListRail({
  skills,
  isLoading,
  searchQuery,
  onSearchChange,
  selectedSkillId,
  onSelectSkill,
}: SkillListRailProps) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return skills
    const q = searchQuery.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.directoryName.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)),
    )
  }, [skills, searchQuery])

  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      {/* Search */}
      <div className="shrink-0 border-b border-border/40 p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            type="text"
            placeholder="Search skills…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* Skill list */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          '[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
          '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
          'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
        )}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Wrench className="mb-2 size-6 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              {searchQuery.trim() ? 'No matching skills' : 'No skills found'}
            </p>
          </div>
        ) : (
          <div className="p-1">
            {filtered.map((skill) => (
              <SkillListItem
                key={skill.skillId}
                skill={skill}
                isSelected={skill.skillId === selectedSkillId}
                onClick={() => onSelectSkill(skill.skillId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Skill list item                                                   */
/* ------------------------------------------------------------------ */

function SkillListItem({
  skill,
  isSelected,
  onClick,
}: {
  skill: SkillInventoryEntry
  isSelected: boolean
  onClick: () => void
}) {
  const envLabel = skill.envCount > 0 ? `${skill.envCount} env` : null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors',
        'hover:bg-accent/50',
        isSelected && 'bg-accent text-accent-foreground',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-medium">{skill.name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SkillSourceBadge sourceKind={skill.sourceKind} />
        {envLabel && (
          <Badge
            variant="secondary"
            className="px-1.5 py-0 text-[10px] font-normal leading-4"
          >
            {envLabel}
          </Badge>
        )}
        {skill.hasRichConfig && (
          <Badge
            variant="secondary"
            className="px-1.5 py-0 text-[10px] font-normal leading-4"
          >
            Config
          </Badge>
        )}
      </div>
      {skill.description && (
        <p className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
          {skill.description}
        </p>
      )}
    </button>
  )
}

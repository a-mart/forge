import { useMemo, type ReactNode } from 'react'
import {
  MANAGER_REASONING_LEVELS,
  type DelegationBehaviorMode,
  type DelegationRoster,
  type DelegationRoute,
  type ManagerReasoningLevel,
  type ModelPresetInfo,
  type ResolvedSpecialistDefinition,
} from '@forge/protocol'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  MoreHorizontal,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  getModelDisplayLabel,
  getSupportedReasoningLevelsForModelId,
  type SelectableModel,
} from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import { formatReasoningLevel } from '@/lib/reasoning-level-labels'
import { ModelIdSelect } from './ModelIdSelect'
import {
  TASK_TYPE_DESCRIPTIONS,
  TASK_TYPE_LABELS,
  behaviorModeForSpecialist,
  isDefaultSpecialistForTask,
  taskAssignmentLabel,
  tasksUsingPolicy,
} from './delegation-preset-utils'

export function DelegationPolicyEditor({
  policy,
  preset,
  modelPresets,
  selectableModels,
  instruction,
  advancedOpen,
  onAdvancedOpenChange,
  onChange,
  onBehaviorModeChange,
  onMakeDefault,
  onDuplicate,
  onDelete,
}: {
  policy: DelegationRoute
  preset: DelegationRoster
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  instruction?: ResolvedSpecialistDefinition
  advancedOpen: boolean
  onAdvancedOpenChange: (open: boolean) => void
  onChange: (policy: DelegationRoute) => void
  onBehaviorModeChange: (behaviorMode: DelegationBehaviorMode) => void
  onMakeDefault: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const behaviorMode = behaviorModeForSpecialist(preset, policy.routeId)
  const isDefault = isDefaultSpecialistForTask(preset, policy.routeId)
  const assignedTasks = tasksUsingPolicy(preset, policy.routeId)
  const taskLabel = taskAssignmentLabel(preset, policy.routeId)
  const isSharedReviewDefault = assignedTasks.length === 2
    && assignedTasks.includes('correctness-review')
    && assignedTasks.includes('design-review')
  const escalatedFrom = preset.routes.filter(
    (candidate) => candidate.capabilityEscalationRouteId === policy.routeId,
  )
  const escalationPolicy = preset.routes.find(
    (candidate) => candidate.routeId === policy.capabilityEscalationRouteId,
  )
  const supportedLevels = getSupportedReasoningLevelsForModelId(
    policy.modelId,
    modelPresets,
    policy.provider,
  )
  const fallbackLevels = policy.availabilityFallback
    ? getSupportedReasoningLevelsForModelId(
        policy.availabilityFallback.modelId,
        modelPresets,
        policy.availabilityFallback.provider,
      )
    : MANAGER_REASONING_LEVELS
  const usage = isDefault
    ? `Default ${taskLabel.toLocaleLowerCase()} specialist`
    : escalatedFrom.length > 0
      ? `${TASK_TYPE_LABELS[behaviorMode]} alternative · reached from ${escalatedFrom.map((candidate) => candidate.label).join(', ')}`
      : `${TASK_TYPE_LABELS[behaviorMode]} alternative · chosen deliberately by the manager`

  return (
    <section aria-label={`${policy.label} roster specialist`} className="min-w-0 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold">{policy.label}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{usage}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`${policy.label} specialist actions`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy className="size-4" />
              Duplicate specialist
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={preset.routes.length <= 1 || isDefault}
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              Delete specialist
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AttemptChain
        policy={policy}
        escalationPolicy={escalationPolicy}
        modelPresets={modelPresets}
      />

      <div className="rounded-lg border border-border/60 bg-card/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold">Task instructions</h4>
            <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Defines what this specialist does. Its model and recovery settings belong to this
              roster entry.
            </p>
          </div>
          {isDefault ? (
            <span className="rounded bg-muted px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
              Default for {taskLabel}
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={onMakeDefault}>
              Make default for {TASK_TYPE_LABELS[behaviorMode]}
            </Button>
          )}
        </div>
        <div className="mt-4 grid gap-4 min-[1700px]:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label>{isSharedReviewDefault ? 'Task coverage' : 'Task type'}</Label>
            {isSharedReviewDefault ? (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm">
                Correctness and design review
              </div>
            ) : (
              <Select value={behaviorMode} onValueChange={(value) => {
                onBehaviorModeChange(value as DelegationBehaviorMode)
              }}>
                <SelectTrigger className="w-full" aria-label="Specialist task type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TASK_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
            <p className="text-xs font-medium">{taskLabel}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {isSharedReviewDefault
                ? 'The requested review focus applies the appropriate built-in instructions while this specialist owns the model and recovery behavior.'
                : (instruction?.whenToUse || TASK_TYPE_DESCRIPTIONS[behaviorMode])}
            </p>
            {instruction?.promptBody && (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  Preview shared instructions
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border/50 bg-background/40 p-2 font-sans text-[11px] leading-relaxed">
                  {instruction.promptBody}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 min-[1700px]:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-card/30 p-4">
          <h4 className="text-sm font-semibold">Specialist</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The name the manager sees when it delegates this work.
          </p>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor={`policy-name-${policy.routeId}`}>Specialist name</Label>
            <Input
              id={`policy-name-${policy.routeId}`}
              value={policy.label}
              onChange={(event) => onChange({ ...policy, label: event.target.value })}
            />
          </div>
        </div>

        <div className="rounded-lg border border-border/60 bg-card/30 p-4">
          <h4 className="text-sm font-semibold">Model</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Capability and cost of the first attempt.
          </p>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label>Primary model</Label>
              <ModelIdSelect
                modelId={policy.modelId}
                provider={policy.provider}
                models={selectableModels}
                presets={modelPresets}
                onValueChange={(model) => onChange({
                  ...policy,
                  ...model,
                  reasoningLevel: keepSupportedReasoning(
                    policy.reasoningLevel,
                    getSupportedReasoningLevelsForModelId(
                      model.modelId,
                      modelPresets,
                      model.provider,
                    ),
                  ),
                })}
              />
            </div>
            <ReasoningButtons
              value={policy.reasoningLevel}
              levels={supportedLevels}
              onChange={(reasoningLevel) => onChange({ ...policy, reasoningLevel })}
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-card/30 p-4">
        <h4 className="text-sm font-semibold">When to use this specialist</h4>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Helps the manager decide whether this specialist is the right executor for the task.
          Describe capability, cost, speed, ambiguity, and risk.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`policy-use-${policy.routeId}`}>Use when</Label>
            <Textarea
              id={`policy-use-${policy.routeId}`}
              value={policy.useWhen}
              rows={3}
              onChange={(event) => onChange({ ...policy, useWhen: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`policy-avoid-${policy.routeId}`}>Avoid when</Label>
            <Textarea
              id={`policy-avoid-${policy.routeId}`}
              value={policy.avoidWhen ?? ''}
              rows={3}
              placeholder="Optional"
              onChange={(event) => onChange({
                ...policy,
                avoidWhen: event.target.value || undefined,
              })}
            />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35"
          onClick={() => onAdvancedOpenChange(!advancedOpen)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen
            ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Advanced & recovery</span>
            <span className="block truncate text-xs text-muted-foreground">
              Fallback: {policy.availabilityFallback
                ? getModelDisplayLabel(
                    policy.availabilityFallback.modelId,
                    modelPresets,
                    policy.availabilityFallback.provider,
                  )
                : 'None'}
              {' · '}New attempt on: {escalationPolicy?.label ?? 'None'}
            </span>
          </span>
        </button>

        {advancedOpen && (
          <div className="border-t border-border/60 p-4">
            <div className="grid gap-4 xl:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Fallback model</Label>
                <ModelIdSelect
                  modelId={policy.availabilityFallback?.modelId ?? ''}
                  provider={policy.availabilityFallback?.provider ?? ''}
                  models={selectableModels}
                  presets={modelPresets}
                  placeholder="None"
                  allowNone
                  onValueChange={(model) => onChange({
                    ...policy,
                    availabilityFallback: model.modelId
                      ? {
                          ...model,
                          reasoningLevel: keepSupportedReasoning(
                            policy.availabilityFallback?.reasoningLevel
                              ?? policy.reasoningLevel,
                            getSupportedReasoningLevelsForModelId(
                              model.modelId,
                              modelPresets,
                              model.provider,
                            ),
                          ),
                        }
                      : undefined,
                  })}
                />
                <p className="text-[11px] text-muted-foreground">
                  Used only when the primary model is unavailable.
                </p>
              </div>

              <ReasoningSelect
                label="Fallback reasoning"
                value={policy.availabilityFallback?.reasoningLevel ?? policy.reasoningLevel}
                levels={fallbackLevels}
                disabled={!policy.availabilityFallback}
                onChange={(reasoningLevel) => {
                  if (!policy.availabilityFallback) return
                  onChange({
                    ...policy,
                    availabilityFallback: {
                      ...policy.availabilityFallback,
                      reasoningLevel,
                    },
                  })
                }}
              />

              <div className="space-y-1.5">
                <Label>New attempt on</Label>
                <Select
                  value={policy.capabilityEscalationRouteId ?? '__none__'}
                  onValueChange={(value) => onChange({
                    ...policy,
                    capabilityEscalationRouteId: value === '__none__' ? undefined : value,
                  })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {preset.routes
                      .filter((candidate) => candidate.routeId !== policy.routeId)
                      .map((candidate) => (
                        <SelectItem key={candidate.routeId} value={candidate.routeId}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Starts a fresh attempt on another roster specialist after evidence that this
                  specialist was not capable enough.
                </p>
              </div>
            </div>

            <div className="mt-4 max-w-sm space-y-1.5">
              <Label htmlFor={`policy-id-${policy.routeId}`}>Internal identifier</Label>
              <Input
                id={`policy-id-${policy.routeId}`}
                value={policy.routeId}
                readOnly
                className="font-mono text-xs text-muted-foreground"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Referenced by existing sessions and configuration. This is an advanced
                compatibility field.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function AttemptChain({
  policy,
  escalationPolicy,
  modelPresets,
}: {
  policy: DelegationRoute
  escalationPolicy?: DelegationRoute
  modelPresets: ModelPresetInfo[]
}) {
  const primaryLabel = getModelDisplayLabel(policy.modelId, modelPresets, policy.provider)
  const primaryLevels = getSupportedReasoningLevelsForModelId(
    policy.modelId,
    modelPresets,
    policy.provider,
  )
  const fallbackLabel = policy.availabilityFallback
    ? getModelDisplayLabel(
        policy.availabilityFallback.modelId,
        modelPresets,
        policy.availabilityFallback.provider,
      )
    : 'No fallback'
  const fallbackLevels = policy.availabilityFallback
    ? getSupportedReasoningLevelsForModelId(
        policy.availabilityFallback.modelId,
        modelPresets,
        policy.availabilityFallback.provider,
      )
    : []
  const escalationModel = escalationPolicy
    ? getModelDisplayLabel(escalationPolicy.modelId, modelPresets, escalationPolicy.provider)
    : 'No escalation'
  const escalationLevels = escalationPolicy
    ? getSupportedReasoningLevelsForModelId(
        escalationPolicy.modelId,
        modelPresets,
        escalationPolicy.provider,
      )
    : []

  return (
    <div className="rounded-lg border border-border/60 bg-card/30 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold">Attempt chain</h4>
        <span className="text-xs text-muted-foreground">
          what runs, and what happens if it can&apos;t
        </span>
      </div>
      <div className="mt-3 grid items-center gap-2 min-[1700px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <AttemptCard
          icon={<Play className="size-3" />}
          eyebrow="First attempt"
          title={primaryLabel}
          detail={`${formatReasoningLevel(policy.reasoningLevel, primaryLevels)} reasoning`}
        />
        <AttemptConnector label="if the model is unavailable" />
        <AttemptCard
          icon={<RefreshCw className="size-3" />}
          eyebrow="Same attempt, other model"
          title={fallbackLabel}
          detail={policy.availabilityFallback
            ? `${formatReasoningLevel(policy.availabilityFallback.reasoningLevel, fallbackLevels)} reasoning`
            : 'the attempt reports the failure'}
          muted={!policy.availabilityFallback}
          dashed
        />
        <AttemptConnector label="if this specialist was not capable enough" warm />
        <AttemptCard
          icon={<ArrowRight className="size-3" />}
          eyebrow="New attempt on"
          title={escalationPolicy?.label ?? 'No escalation'}
          detail={escalationPolicy
            ? `${escalationModel} · ${formatReasoningLevel(escalationPolicy.reasoningLevel, escalationLevels)}`
            : 'the result is reported as-is'}
          muted={!escalationPolicy}
          warm
          dashed
        />
      </div>
      <p className="mt-3 max-w-4xl text-xs leading-relaxed text-muted-foreground">
        A fallback swaps the model when the primary is unavailable; the same worker attempt
        continues. Capability escalation starts a fresh attempt using another roster specialist.
      </p>
    </div>
  )
}

function AttemptCard({
  icon,
  eyebrow,
  title,
  detail,
  muted,
  warm,
  dashed,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  detail: string
  muted?: boolean
  warm?: boolean
  dashed?: boolean
}) {
  return (
    <div className={cn(
      'min-w-0 rounded-md border p-3',
      dashed && 'border-dashed',
      muted && 'opacity-60',
      warm
        ? 'border-amber-500/30 bg-amber-500/[0.04]'
        : 'border-border/70 bg-muted/20',
    )}>
      <div className={cn(
        'flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide',
        warm ? 'text-amber-300/80' : 'text-muted-foreground',
      )}>
        {icon}
        {eyebrow}
      </div>
      <p className="mt-1 truncate text-sm font-semibold">{title}</p>
      <p className="truncate text-[11px] text-muted-foreground">{detail}</p>
    </div>
  )
}

function AttemptConnector({ label, warm }: { label: string; warm?: boolean }) {
  return (
    <div className={cn(
      'flex items-center justify-center gap-1 text-center text-[10px] leading-tight min-[1700px]:w-24',
      warm ? 'text-amber-300/75' : 'text-muted-foreground',
    )}>
      <span>{label}</span>
      <ArrowRight className="hidden size-3 shrink-0 min-[1700px]:block" />
    </div>
  )
}

function ReasoningButtons({
  value,
  levels,
  onChange,
}: {
  value: ManagerReasoningLevel
  levels: readonly ManagerReasoningLevel[]
  onChange: (level: ManagerReasoningLevel) => void
}) {
  const displayLevels = useMemo(
    () => levels.filter((level, index) => levels.indexOf(level) === index),
    [levels],
  )
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">Reasoning effort</legend>
      <div className="flex flex-wrap rounded-md border border-border/70 bg-muted/20 p-1">
        {displayLevels.map((level) => (
          <button
            key={level}
            type="button"
            className={cn(
              'min-w-14 flex-1 rounded-sm px-2 py-1.5 text-xs transition-colors',
              value === level
                ? 'bg-foreground text-background shadow-sm'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            onClick={() => onChange(level)}
            aria-pressed={value === level}
          >
            {formatReasoningLevel(level, displayLevels)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ReasoningSelect({
  label,
  value,
  levels,
  disabled,
  onChange,
}: {
  label: string
  value: ManagerReasoningLevel
  levels: readonly ManagerReasoningLevel[]
  disabled?: boolean
  onChange: (level: ManagerReasoningLevel) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(level) => onChange(level as ManagerReasoningLevel)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {formatReasoningLevel(level, levels)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function keepSupportedReasoning(
  current: ManagerReasoningLevel,
  supported: readonly ManagerReasoningLevel[],
): ManagerReasoningLevel {
  if (supported.includes(current)) return current
  if (supported.includes('medium')) return 'medium'
  return supported[0] ?? 'none'
}

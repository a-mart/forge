import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AgentSystemPromptResponse } from './system-prompt-api'

type InitialModelInputCapture = Extract<
  AgentSystemPromptResponse['initialModelInput'],
  { status: 'available' }
>['capture']

export type InitialModelInputViewMode = 'prompt' | 'raw'

type PromptSourceKind =
  | 'system'
  | 'project'
  | 'memory'
  | 'skills'
  | 'reference'
  | 'recovery'
  | 'runtime'

interface PromptDisplaySection {
  id: string
  kind: PromptSourceKind
  label: string
  source?: string
  content: string
}

interface SkillDisplayModel {
  id: string
  name: string
  description?: string
  location: string
}

interface SkillCatalogModel {
  skills: SkillDisplayModel[]
  unformattedEntries: number
  hasSkillMarkup: boolean
}

interface ToolParameter {
  name: string
  type: string
  description?: string
  required: boolean
}

interface ToolDisplayModel {
  id: string
  name: string
  description?: string
  parameters: ToolParameter[]
  schema?: unknown
}

const SOURCE_STYLES: Record<PromptSourceKind, { accent: string; badge: string }> = {
  system: {
    accent: 'bg-sky-500',
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
  project: {
    accent: 'bg-emerald-500',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  memory: {
    accent: 'bg-violet-500',
    badge: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  skills: {
    accent: 'bg-amber-500',
    badge: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  reference: {
    accent: 'bg-cyan-500',
    badge: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  },
  recovery: {
    accent: 'bg-orange-500',
    badge: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  },
  runtime: {
    accent: 'bg-slate-500',
    badge: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  },
}

const STRUCTURED_PROMPT_BLOCK = /<project_instructions\s+path="([^"]+)">\r?\n?([\s\S]*?)\r?\n?<\/project_instructions>|<available_skills>\r?\n?([\s\S]*?)\r?\n?<\/available_skills>|<agent_reference_docs>\r?\n?([\s\S]*?)\r?\n?<\/agent_reference_docs>/g
const RUNTIME_FOOTER = /(^|\n)(Current date: \d{4}-\d{2}-\d{2}\nCurrent working directory: [^\n]+)\s*$/

export function InitialModelInputContent({
  capture,
  rawCapture,
  mode,
}: {
  capture: InitialModelInputCapture
  rawCapture: string
  mode: InitialModelInputViewMode
}) {
  if (mode === 'raw') {
    return (
      <section aria-label="Raw initial model input" className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Raw JSON</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Complete persisted capture, including messages and safe request metadata.
          </p>
        </div>
        <pre className="whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-muted/20 p-4 font-mono text-[12px] leading-relaxed text-foreground/90">
          {rawCapture}
        </pre>
      </section>
    )
  }

  const promptSections = derivePromptSections(capture.systemPrompt)
  const tools = deriveTools(capture.tools)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="font-mono font-medium">
          {capture.model.provider}/{capture.model.id}
        </Badge>
        <span aria-hidden="true">•</span>
        <span>First Pi request</span>
        <span aria-hidden="true">•</span>
        <time dateTime={capture.capturedAt}>{formatCapturedAt(capture.capturedAt)}</time>
      </div>

      <section aria-labelledby="initial-model-system-prompt" className="space-y-3">
        <div>
          <h2 id="initial-model-system-prompt" className="text-sm font-semibold">
            System prompt
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Source labels show where each block entered the resolved prompt.
          </p>
        </div>

        <div className="space-y-3">
          {promptSections.map((section) => (
            <PromptSourceBlock key={section.id} section={section} />
          ))}
        </div>
      </section>

      <section aria-labelledby="initial-model-tools" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 id="initial-model-tools" className="text-sm font-semibold">
              Tools sent to the model
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Names, descriptions, and top-level input parameters from the first request.
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
            {tools.length}
          </Badge>
        </div>

        {tools.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {tools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No tools were included in this request.
          </p>
        )}
      </section>
    </div>
  )
}

function PromptSourceBlock({ section }: { section: PromptDisplaySection }) {
  const style = SOURCE_STYLES[section.kind]
  const skillCatalog = section.kind === 'skills' ? deriveSkills(section.content) : undefined
  return (
    <article className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/15 px-5 py-3">
      <span className={cn('absolute inset-y-0 left-0 w-1', style.accent)} aria-hidden="true" />
      <header className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px] font-semibold uppercase tracking-wide', style.badge)}>
          {section.label}
        </Badge>
        {section.source ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={section.source}>
            {section.source}
          </span>
        ) : null}
        {skillCatalog?.hasSkillMarkup && skillCatalog.skills.length > 0 ? (
          <Badge variant="secondary" className="font-mono text-[10px] font-normal text-muted-foreground">
            {skillCatalog.skills.length} {skillCatalog.skills.length === 1 ? 'skill' : 'skills'}
          </Badge>
        ) : null}
      </header>
      {skillCatalog?.hasSkillMarkup ? (
        <SkillCatalog catalog={skillCatalog} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground/90">
          {section.content}
        </pre>
      )}
    </article>
  )
}

function SkillCatalog({ catalog }: { catalog: SkillCatalogModel }) {
  return (
    <div className="space-y-3">
      {catalog.skills.length > 0 ? (
        <div className="grid gap-2 xl:grid-cols-2">
          {catalog.skills.map((skill) => (
            <div key={skill.id} className="rounded-md border border-border/50 bg-background/35 p-3">
              <code className="text-sm font-semibold text-foreground">{skill.name}</code>
              {skill.description ? (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {skill.description}
                </p>
              ) : null}
              <div className="mt-2 border-t border-border/40 pt-2">
                <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/75">
                  Location
                </span>
                <code className="mt-0.5 block truncate text-[10px] leading-relaxed text-muted-foreground" title={skill.location}>
                  {skill.location}
                </code>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {catalog.unformattedEntries > 0 ? (
        <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
          {catalog.unformattedEntries === 1 ? 'One skill entry could' : `${catalog.unformattedEntries} skill entries could`} not be formatted. Open Raw JSON to inspect the exact captured value.
        </p>
      ) : null}
    </div>
  )
}

function ToolCard({ tool }: { tool: ToolDisplayModel }) {
  return (
    <article className="rounded-lg border border-border/60 bg-muted/15 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <code className="text-sm font-semibold text-foreground">{tool.name}</code>
          {tool.description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tool.description}</p>
          ) : null}
        </div>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px] font-normal text-muted-foreground">
          {tool.parameters.length} {tool.parameters.length === 1 ? 'parameter' : 'parameters'}
        </Badge>
      </div>

      {tool.parameters.length > 0 ? (
        <dl className="mt-3 divide-y divide-border/50 rounded-md border border-border/50 bg-background/35">
          {tool.parameters.map((parameter) => (
            <div key={parameter.name} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(9rem,0.35fr)_1fr]">
              <dt className="flex min-w-0 flex-wrap items-center gap-1.5">
                <code className="break-all text-xs font-medium text-foreground">{parameter.name}</code>
                <span className="font-mono text-[10px] text-muted-foreground">{parameter.type}</span>
                {parameter.required ? (
                  <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">required</span>
                ) : null}
              </dt>
              <dd className="text-xs leading-relaxed text-muted-foreground">
                {parameter.description ?? <span aria-label="No description provided">—</span>}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {tool.schema !== undefined ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium hover:text-foreground">
            View complete schema
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border border-border/50 bg-background/35 p-3 font-mono text-[11px] leading-relaxed text-foreground/85">
            {JSON.stringify(tool.schema, null, 2)}
          </pre>
        </details>
      ) : null}
    </article>
  )
}

function derivePromptSections(systemPrompt: string): PromptDisplaySection[] {
  const sections: PromptDisplaySection[] = []
  const normalizedPrompt = systemPrompt.replace(/\r\n/g, '\n')
  let cursor = 0
  let match: RegExpExecArray | null
  let sequence = 0

  const pushSection = (
    kind: PromptSourceKind,
    label: string,
    content: string,
    source?: string,
  ) => {
    const trimmed = content.trim()
    if (!trimmed) return
    sections.push({
      id: `${kind}-${sequence++}`,
      kind,
      label,
      ...(source ? { source } : {}),
      content: trimmed,
    })
  }

  const pushUnstructured = (value: string) => {
    const runtimeMatch = RUNTIME_FOOTER.exec(value)
    if (!runtimeMatch || runtimeMatch.index === undefined) {
      pushGenericPromptText(value, pushSection)
      return
    }

    const runtimeStart = runtimeMatch.index + runtimeMatch[1].length
    pushGenericPromptText(value.slice(0, runtimeStart), pushSection)
    pushSection('runtime', 'Runtime', runtimeMatch[2])
  }

  STRUCTURED_PROMPT_BLOCK.lastIndex = 0
  while ((match = STRUCTURED_PROMPT_BLOCK.exec(normalizedPrompt)) !== null) {
    pushUnstructured(normalizedPrompt.slice(cursor, match.index))

    if (match[1] !== undefined) {
      const source = decodeXml(match[1])
      const sourceKind = classifyProjectSource(source)
      pushSection(sourceKind.kind, sourceKind.label, match[2] ?? '', source)
    } else if (match[3] !== undefined) {
      pushSection('skills', 'Skills', match[3])
    } else if (match[4] !== undefined) {
      pushSection('reference', 'Reference docs', match[4])
    }

    cursor = STRUCTURED_PROMPT_BLOCK.lastIndex
  }

  pushUnstructured(normalizedPrompt.slice(cursor))

  return sections.length > 0
    ? sections
    : [{ id: 'system-0', kind: 'system', label: 'System instructions', content: systemPrompt }]
}

function pushGenericPromptText(
  value: string,
  pushSection: (kind: PromptSourceKind, label: string, content: string, source?: string) => void,
) {
  const cleaned = value
    .replace(/<project_context>\s*\n\s*Project-specific instructions and guidelines:\s*(?=\n|$)/g, '\n')
    .replace(/(^|\n)<\/project_context>\s*(?=\n|$)/g, '\n')
    .trim()
  if (!cleaned) return

  const projectContextIndex = cleaned.indexOf('# Project Context')
  if (projectContextIndex >= 0) {
    pushSection('system', 'System instructions', cleaned.slice(0, projectContextIndex))
    pushSection(
      'project',
      'Project context',
      cleaned.slice(projectContextIndex + '# Project Context'.length),
    )
    return
  }

  if (cleaned.startsWith('The following skills provide specialized instructions')) {
    pushSection('skills', 'Skills', cleaned)
    return
  }

  if (cleaned.startsWith('Project agents in this profile')) {
    pushSection('project', 'Project agents', cleaned)
    return
  }

  pushSection('system', 'System instructions', cleaned)
}

function classifyProjectSource(source: string): { kind: PromptSourceKind; label: string } {
  const normalized = source.toLowerCase()
  if (normalized.includes('memory.md')) {
    return { kind: 'memory', label: 'Memory' }
  }
  if (normalized.replace(/\\/g, '/').endsWith('/.forge/ephemeral-model-change-recovery.md')) {
    return { kind: 'recovery', label: 'Recovery context' }
  }
  return { kind: 'project', label: 'Project instructions' }
}

function deriveSkills(content: string): SkillCatalogModel {
  const skills: SkillDisplayModel[] = []
  let unformattedEntries = 0
  let matchedEntries = 0
  const skillBlock = /<skill>\s*([\s\S]*?)\s*<\/skill>/g
  let match: RegExpExecArray | null

  while ((match = skillBlock.exec(content)) !== null) {
    matchedEntries += 1
    const name = readXmlElement(match[1], 'name')
    const description = readXmlElement(match[1], 'description')
    const location = readXmlElement(match[1], 'location')
    if (!name || !location) {
      unformattedEntries += 1
      continue
    }
    skills.push({
      id: `${name}-${matchedEntries}`,
      name,
      ...(description ? { description } : {}),
      location,
    })
  }

  const residualMarkup = content.replace(/<skill>\s*[\s\S]*?\s*<\/skill>/g, '').trim()
  const hasSkillMarkup = matchedEntries > 0 || /<\/?skill(?:\s|>)/.test(content)
  if (hasSkillMarkup && residualMarkup.length > 0) {
    unformattedEntries += 1
  }

  return { skills, unformattedEntries, hasSkillMarkup }
}

function readXmlElement(value: string, element: 'name' | 'description' | 'location'): string | undefined {
  const match = new RegExp(`<${element}>([\\s\\S]*?)<\\/${element}>`).exec(value)
  if (!match) return undefined
  return readString(decodeXml(match[1]))
}

function deriveTools(values: InitialModelInputCapture['tools']): ToolDisplayModel[] {
  return values.map((value, index) => {
    const record = asRecord(value)
    const name = readString(record?.name) ?? `Tool ${index + 1}`
    const description = readString(record?.description)
    const schema = record?.parameters ?? record?.inputSchema
    const schemaRecord = asRecord(schema)
    const propertyRecords = asRecord(schemaRecord?.properties)
    const required = new Set(
      Array.isArray(schemaRecord?.required)
        ? schemaRecord.required.filter((entry): entry is string => typeof entry === 'string')
        : [],
    )
    const parameters = Object.entries(propertyRecords ?? {}).map(([parameterName, parameterValue]) => {
      const parameterRecord = asRecord(parameterValue)
      return {
        name: parameterName,
        type: describeSchemaType(parameterRecord),
        ...(readString(parameterRecord?.description)
          ? { description: readString(parameterRecord?.description)! }
          : {}),
        required: required.has(parameterName),
      }
    })

    return {
      id: `${name}-${index}`,
      name,
      ...(description ? { description } : {}),
      parameters,
      ...(schema !== undefined ? { schema } : {}),
    }
  })
}

function describeSchemaType(schema: Record<string, unknown> | undefined): string {
  const type = readString(schema?.type)
  if (type) return type
  if (Array.isArray(schema?.enum)) return 'enum'
  if (Array.isArray(schema?.anyOf)) return 'union'
  if (Array.isArray(schema?.oneOf)) return 'union'
  return 'value'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function formatCapturedAt(value: string): string {
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString()
}

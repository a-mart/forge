import type { WorkGraphAttempt, WorkGraphNode, WorkGraphSnapshot } from '@forge/protocol'
import { formatTimestamp } from '../message-list/message-row-utils'
import { workGraphNodeStatusLabel } from './work-graph-node-status'

/** Render snapshot text literally: returned results are data, never instructions or HTML. */
export function WorkGraphInspector({ id, node, graph }: {
  id: string
  node: WorkGraphNode
  graph: WorkGraphSnapshot
}) {
  const unresolved = node.dependsOn.filter((dependency) =>
    graph.nodes.find((candidate) => candidate.id === dependency)?.status !== 'completed')
  const attempts = [...node.attempts].reverse()
  return (
    <section id={id} aria-label={`Step inspector: ${node.title}`} className="min-w-0 space-y-4 rounded-lg border border-border/60 bg-muted/20 p-2 sm:p-3 text-xs">
      <header className="space-y-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Step inspector · {node.kind}</p>
        <h3 className="text-sm font-semibold">{node.title}</h3>
        <p role="status" className="font-medium">{workGraphNodeStatusLabel(node.status)}</p>
        <p className="text-muted-foreground">{node.status === 'completed'
          ? 'Manager accepted this step.'
          : node.status === 'awaiting_review'
            ? 'Worker succeeded. Manager acceptance is still required.'
            : node.status === 'waiting'
              ? 'Waiting for a decision; this step does not dispatch automatically.'
              : 'This step has not been accepted by the manager.'}</p>
        {node.statusUpdatedAt ? <p className="text-muted-foreground">Status updated: <Timestamp value={node.statusUpdatedAt} /></p> : null}
      </header>
      <section aria-label="Assignment" className="space-y-1">
        <h4 className="font-medium">Assignment</h4>
        <StoredText text={node.task || 'No assignment recorded.'} />
      </section>
      <section aria-label="Acceptance criteria" className="space-y-1">
        <h4 className="font-medium">Acceptance criteria</h4>
        <StoredText text={node.acceptanceCriteria || 'No acceptance criteria recorded.'} />
      </section>
      <section aria-label="Dependencies" className="space-y-1">
        <h4 className="font-medium">Unresolved dependencies · {unresolved.length}</h4>
        <p className="text-muted-foreground">Only accepted steps satisfy dependencies.</p>
        {node.dependsOn.length === 0 ? <p>No dependencies.</p> : (
          <ul className="space-y-1">
            {node.dependsOn.map((dependency) => {
              const source = graph.nodes.find((candidate) => candidate.id === dependency)
              return <li key={dependency}>{source?.title ?? dependency} · {source ? workGraphNodeStatusLabel(source.status) : 'Missing from snapshot'}{source?.status !== 'completed' ? ' · Unresolved' : ''}</li>
            })}
          </ul>
        )}
        {node.dependsOn.length > 0 && unresolved.length === 0 ? <p>All dependencies accepted. Dispatch also depends on step status, decision gates, and available capacity.</p> : null}
      </section>
      <section aria-label="Execution attempts" className="space-y-2">
        <h4 className="font-medium">Execution attempts · {attempts.length}</h4>
        <p className="text-muted-foreground">Newest first. Attempt success is not manager acceptance.</p>
        {attempts.length === 0 ? <p>No execution attempts recorded.</p> : attempts.map((attempt, index) => (
          <details key={attempt.id} open={index === 0 ? true : undefined} className="rounded-md border border-border/60 bg-background/50 p-2">
            <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Attempt {attempt.number} · {attempt.status === 'succeeded' ? 'Succeeded (worker result)' : attempt.status}</summary>
            <AttemptDetails attempt={attempt} />
          </details>
        ))}
      </section>
    </section>
  )
}

function AttemptDetails({ attempt }: { attempt: WorkGraphAttempt }) {
  return <div className="mt-2 space-y-2">
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-muted-foreground sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&>dt]:font-medium [&>dd]:mb-2 [&>dd]:min-w-0 [&>dd]:[overflow-wrap:break-word]">
      <dt>Worker</dt><dd>{attempt.workerId || 'Not recorded'}</dd>
      <dt>Specialist</dt><dd>{attempt.resolvedRouteLabel ?? attempt.resolvedRouteId ?? attempt.executionPolicy ?? 'Not recorded'}</dd>
      <dt>Requested route</dt><dd>{attempt.requestedRoute ?? 'Not recorded'}</dd>
      <dt>Model</dt><dd>{attempt.model ? `${attempt.model.provider} / ${attempt.model.modelId}` : 'Not recorded'}</dd>
      {attempt.model?.thinkingLevel ? <><dt>Reasoning</dt><dd>{attempt.model.thinkingLevel}</dd></> : null}
      <dt>Started</dt><dd><Timestamp value={attempt.startedAt} /></dd>
      <dt>Finished</dt><dd><Timestamp value={attempt.completedAt} /></dd>
    </dl>
    <h5 className="font-medium">Returned result summary</h5>
    <StoredText text={attempt.summary ?? 'No result summary recorded.'} />
  </div>
}

function StoredText({ text }: { text: string }) {
  if (text.length <= 480) return <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">{text}</p>
  return <details className="group">
    <summary className="cursor-pointer rounded [overflow-wrap:anywhere] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="line-clamp-3 group-open:hidden">{text.slice(0, 240)}…</span>
      <span className="block font-medium"><span className="group-open:hidden">Show full text</span><span className="hidden group-open:inline">Hide full text</span></span>
    </summary>
    <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">{text}</p>
  </details>
}

function Timestamp({ value }: { value?: string }) {
  if (!value) return <>Not recorded</>
  const formatted = formatTimestamp(value, { includeDate: true })
  return formatted ? <time dateTime={value} title={value}>{formatted}</time> : <span>{value}</span>
}

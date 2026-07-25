import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ExternalChromeCandidateWindow, ExternalChromeChildPolicy } from '@forge/protocol'
import { AlertTriangle, Chrome, Unplug } from 'lucide-react'
import type {
  ExternalChromeLocalError,
  ExternalChromeLocalStatus,
  ExternalChromeRuntimeInstance,
} from '@/lib/electron-bridge'
import { cn } from '@/lib/utils'

interface ExternalChromePanelProps { sessionAgentId: string; profileId: string }

type Phase = 'loading' | 'ready' | 'candidates' | 'confirming' | 'working'

export function ExternalChromePanel({ sessionAgentId, profileId }: ExternalChromePanelProps) {
  const bridge = window.electronBridge?.windowRole === 'main' ? window.electronBridge.externalChrome : undefined
  const [status, setStatus] = useState<ExternalChromeLocalStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null)
  const [windows, setWindows] = useState<ExternalChromeCandidateWindow[]>([])
  const [selectedTabs, setSelectedTabs] = useState<Set<string>>(new Set())
  const [selectedGroup, setSelectedGroup] = useState<number | null>(null)
  const [childPolicy, setChildPolicy] = useState<ExternalChromeChildPolicy>('manual')
  const [error, setError] = useState<ExternalChromeLocalError | null>(null)
  const [aliases, setAliases] = useState<Record<string, string>>(() => readAliases())

  const refresh = useCallback(async (quiet = false) => {
    if (!bridge) { setPhase('ready'); return }
    if (!quiet) setPhase('loading')
    const result = await bridge.localStatus!(sessionAgentId, profileId)
    if (result.ok) {
      setStatus(result.status)
      setError(null)
      setSelectedInstance((current) => current && result.status.instances.some((item) => item.extensionInstanceId === current)
        ? current : result.status.instances[0]?.extensionInstanceId ?? null)
    } else setError(result.error)
    if (!quiet) setPhase('ready')
  }, [bridge, profileId, sessionAgentId])

  useEffect(() => {
    void refresh()
    if (!bridge) return
    const timer = window.setInterval(() => void refresh(true), 3_000)
    return () => window.clearInterval(timer)
  }, [bridge, refresh])

  const loadCandidates = async (instance: ExternalChromeRuntimeInstance): Promise<void> => {
    if (!bridge) return
    setPhase('loading'); setError(null); setSelectedInstance(instance.extensionInstanceId); setSelectedTabs(new Set()); setSelectedGroup(null)
    const result = await bridge.listCandidates!(sessionAgentId, profileId, instance.extensionInstanceId)
    if (!result.ok) { setError(result.error); setPhase('ready'); return }
    setStatus(result.status); setWindows(result.windows ?? []); setPhase('candidates')
  }
  const confirmAttach = async (): Promise<void> => {
    if (!bridge || !selectedInstance) return
    const tabIds = [...selectedTabs].flatMap((key) => {
      const [instanceId, raw] = splitTabKey(key)
      return instanceId === selectedInstance ? [Number(raw)] : []
    })
    if (tabIds.length === 0) return
    setPhase('working'); setError(null)
    const result = await bridge.attach!({
      sessionAgentId, profileId, extensionInstanceId: selectedInstance, tabIds,
      ...(selectedGroup === null ? {} : { groupId: selectedGroup }), childPolicy, confirmed: true,
    })
    if (!result.ok) { setError(result.error); setPhase('candidates'); return }
    setStatus(result.status); setWindows([]); setSelectedTabs(new Set()); setPhase('ready')
  }
  const detach = async (): Promise<void> => {
    if (!bridge) return
    setPhase('working'); setError(null)
    const result = await bridge.detach!(sessionAgentId, profileId)
    if (!result.ok) { setError(result.error); setPhase('ready'); return }
    setStatus(result.status); setPhase('ready')
  }

  if (!bridge) return <Centered title="External Chrome requires Forge Desktop" detail="Local tab discovery is unavailable in the web app. No Chrome profile or tab was inspected." />
  if (phase === 'loading' && !status) return <Centered title="Checking local External Chrome…" detail="Candidate tab data stays on this device." />

  const attachment = status?.attachment
  if (attachment) {
    const stateLabel = attachment.state === 'attached' ? 'Attached' : attachment.state === 'recovering' ? 'Recovering' : 'Lost'
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-auto bg-background p-4" aria-label="External Chrome workspace">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="flex flex-wrap items-center gap-2"><Chrome className="size-5" /><h2 className="font-medium">{displayAlias(attachment.extensionInstanceId, attachment.profileAlias, aliases)}</h2><Badge tone={attachment.state === 'attached' ? 'good' : 'warn'}>{stateLabel}</Badge><Badge>Human</Badge><Badge>Agent during a Forge action</Badge></div>
            <p className="mt-2 text-sm text-muted-foreground">Profile {shortId(attachment.extensionInstanceId)} · {attachment.groupId === null ? 'No Chrome group' : `Group ${attachment.groupId}`} · {attachment.tabs.length} {attachment.tabs.length === 1 ? 'tab' : 'tabs'}</p>
            <div className="mt-3 space-y-2">{attachment.tabs.map((tab) => <div key={`${attachment.extensionInstanceId}:${tab.tabId}`} className="rounded border bg-background px-3 py-2"><div className="truncate text-sm font-medium">{tab.title || 'Untitled tab'}</div><div className="truncate text-xs text-muted-foreground">{tab.origin}</div></div>)}</div>
            <button type="button" className="mt-4 inline-flex items-center gap-2 rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" disabled={phase === 'working'} onClick={() => void detach()}><Unplug className="size-4" />Detach now from Forge</button>
          </div>
          <CapabilityNotice />
          {attachment.state !== 'attached' ? <StateNotice error="stale-or-lost" /> : null}
          {error ? <StateNotice error={error} /> : null}
        </div>
      </section>
    )
  }

  const setup = status?.coordinator
  if (setup?.state !== 'online' || setup.setup.pathState !== 'ready') {
    const detail = setupMessage(setup)
    return <Centered title="External Chrome setup required" detail={detail} action={<button type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void refresh()}>Check again</button>} />
  }
  if ((status?.instances.length ?? 0) === 0) return <Centered title="Waiting for the Chrome extension" detail="External Chrome is enabled, but no extension instance is connected. Load or update the unpacked extension in the intended Chrome profile, then check again." action={<button type="button" className="rounded border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void refresh()}>Check again</button>} />

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto bg-background p-4" aria-label="External Chrome workspace">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div><h2 className="font-medium">Connected Chrome profiles</h2><p className="mt-1 text-sm text-muted-foreground">Choose a local extension instance. Candidate titles and origins stay inside Forge Desktop and are never sent to the backend or model logs.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">{status!.instances.map((instance) => (
          <article key={instance.extensionInstanceId} className={cn('rounded-lg border p-3', selectedInstance === instance.extensionInstanceId && 'border-primary')}>
            <div className="flex items-center gap-2"><Chrome className="size-4" /><strong className="min-w-0 flex-1 truncate text-sm">{displayAlias(instance.extensionInstanceId, instance.profileAlias, aliases)}</strong><Badge tone="good">Connected</Badge></div>
            <div className="mt-1 text-xs text-muted-foreground">Chrome {instance.chromeVersion} · {shortId(instance.extensionInstanceId)}</div>
            <label className="mt-3 block text-xs text-muted-foreground">Local alias<input aria-label={`Local alias for ${instance.extensionInstanceId}`} className="mt-1 h-8 w-full rounded border bg-background px-2 text-sm" value={aliases[instance.extensionInstanceId] ?? ''} placeholder={instance.profileAlias ?? 'Chrome profile'} onChange={(event) => setAlias(instance.extensionInstanceId, event.target.value, aliases, setAliases)} /></label>
            <button type="button" className="mt-3 rounded border px-3 py-1.5 text-sm hover:bg-muted" onClick={() => void loadCandidates(instance)}>Attach tabs…</button>
          </article>
        ))}</div>

        {(phase === 'candidates' || phase === 'confirming' || phase === 'working') && selectedInstance ? <CandidatePicker windows={windows} instanceId={selectedInstance} selected={selectedTabs} setSelected={setSelectedTabs} selectedGroup={selectedGroup} setSelectedGroup={setSelectedGroup} childPolicy={childPolicy} setChildPolicy={setChildPolicy} phase={phase} setPhase={setPhase} onConfirm={confirmAttach} sessionAgentId={sessionAgentId} /> : null}
        <CapabilityNotice />
        {error ? <StateNotice error={error} /> : null}
      </div>
    </section>
  )
}

function CandidatePicker(props: { windows: ExternalChromeCandidateWindow[]; instanceId: string; selected: Set<string>; setSelected(value: Set<string>): void; selectedGroup: number | null; setSelectedGroup(value: number | null): void; childPolicy: ExternalChromeChildPolicy; setChildPolicy(value: ExternalChromeChildPolicy): void; phase: Phase; setPhase(value: Phase): void; onConfirm(): Promise<void>; sessionAgentId: string }) {
  const eligible = useMemo(() => props.windows.flatMap((window) => window.tabs).filter((tab) => !tab.restricted && !tab.debuggerConflict && !tab.attached), [props.windows])
  const groups = props.windows.flatMap((window) => window.groups)
  const toggle = (tabId: number) => { const key = tabKey(props.instanceId, tabId); const next = new Set(props.selected); if (next.has(key)) next.delete(key); else next.add(key); props.setSelected(next) }
  return <div className="rounded-lg border p-4" aria-label="Attach External Chrome tabs">
    <div className="flex items-center"><h3 className="font-medium">Attach tabs</h3><span className="ml-auto text-xs text-muted-foreground">{props.selected.size} selected</span></div>
    <div className="mt-3 max-h-72 space-y-3 overflow-auto">{props.windows.map((window) => <div key={window.windowId}><div className="mb-1 text-xs font-medium text-muted-foreground">Window {window.windowId}{window.focused ? ' · focused' : ''}</div>{window.tabs.map((tab) => { const disabled = tab.restricted || tab.debuggerConflict || tab.attached; return <label key={tabKey(props.instanceId, tab.tabId)} className={cn('flex gap-2 rounded px-2 py-2', disabled ? 'opacity-60' : 'hover:bg-muted')}><input type="checkbox" checked={props.selected.has(tabKey(props.instanceId, tab.tabId))} disabled={disabled || props.phase !== 'candidates'} onChange={() => toggle(tab.tabId)} /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-1 text-sm"><span className="truncate">{tab.title || 'Untitled tab'}</span>{tab.restricted ? <Badge tone="bad">Restricted</Badge> : null}{tab.debuggerConflict ? <Badge tone="bad">Debugger conflict</Badge> : null}{tab.attached ? <Badge tone="warn">Attached elsewhere</Badge> : null}</span><span className="block truncate text-xs text-muted-foreground">{tab.origin}</span></span></label>})}</div>)}</div>
    {eligible.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No attachable tabs are available. Restricted pages, debugger conflicts, and tabs already attached cannot be selected.</p> : null}
    <div className="mt-4 grid gap-3 border-t pt-3 sm:grid-cols-2"><label className="text-xs text-muted-foreground">Chrome group<select className="mt-1 h-8 w-full rounded border bg-background px-2 text-sm" value={props.selectedGroup ?? ''} onChange={(event) => { const groupId = event.target.value === '' ? null : Number(event.target.value); props.setSelectedGroup(groupId); if (groupId !== null) props.setSelected(new Set(props.windows.flatMap((window) => window.tabs).filter((tab) => tab.groupId === groupId && !tab.restricted && !tab.debuggerConflict && !tab.attached).map((tab) => tabKey(props.instanceId, tab.tabId)))) }}><option value="">Selected tabs (no group constraint)</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.title || `Group ${group.groupId}`}</option>)}</select></label><div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">To create <strong>Forge · {props.sessionAgentId}</strong>, use <strong>New Forge group</strong> in the extension side panel, then refresh candidates here. Forge never opens a Chrome settings page for you.</div></div>
    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={props.childPolicy === 'include-opened-by-leased-tabs'} onChange={(event) => props.setChildPolicy(event.target.checked ? 'include-opened-by-leased-tabs' : 'manual')} /><span><strong>Include child tabs opened by attached tabs</strong><span className="block text-xs text-muted-foreground">Off by default. Manual policy keeps newly opened child tabs outside the lease.</span></span></label>
    {props.phase === 'confirming' || props.phase === 'working' ? <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3"><strong className="text-sm">Confirm local attachment</strong><p className="mt-1 text-xs text-muted-foreground">Forge will gain debugger access to {props.selected.size} selected {props.selected.size === 1 ? 'tab' : 'tabs'} in this Chrome profile. Page content and authenticated actions may become available to the agent during a turn. Human input interrupts agent control.</p><div className="mt-3 flex gap-2"><button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={props.phase === 'working'} onClick={() => void props.onConfirm()}>Confirm and attach</button><button type="button" className="rounded border px-3 py-1.5 text-sm" disabled={props.phase === 'working'} onClick={() => props.setPhase('candidates')}>Cancel</button></div></div> : <button type="button" className="mt-4 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={props.selected.size === 0} onClick={() => props.setPhase('confirming')}>Review attachment</button>}
  </div>
}

function CapabilityNotice() { return <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground"><strong className="text-foreground">External Chrome M3 limits</strong><p className="mt-1">External tabs stay in Chrome and are never rendered as Electron views. Status, create/open, and navigation are available after attachment. Resize, screenshots/snapshots, recording, download artifacts, opening downloaded files, and dock/pop-out are not available until M4.</p></div> }
function Centered({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <section className="m-auto max-w-lg p-8 text-center" aria-label="External Chrome workspace"><Chrome className="mx-auto mb-3 size-10 text-muted-foreground" /><h2 className="font-medium">{title}</h2><p className="mt-2 text-sm text-muted-foreground">{detail}</p>{action ? <div className="mt-4">{action}</div> : null}</section> }
function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) { return <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', tone === 'good' && 'border-emerald-500/40 bg-emerald-500/10', tone === 'warn' && 'border-amber-500/40 bg-amber-500/10', tone === 'bad' && 'border-destructive/40 bg-destructive/10 text-destructive')}>{children}</span> }
function StateNotice({ error }: { error: ExternalChromeLocalError }) { const messages: Record<ExternalChromeLocalError, string> = { 'invalid-request': 'The local attachment request was rejected. Refresh and try again.', 'setup-required': 'External Chrome is disabled, offline, or needs setup/update in Settings.', 'attachment-required': 'Choose and confirm tabs before Forge can use External Chrome.', 'lease-conflict': 'This Chrome profile or selected tab is controlled by another Forge attachment. Detach it there first.', 'restricted-target': 'Chrome does not allow debugger attachment to this restricted page.', 'debugger-unavailable': 'Chrome debugger access is unavailable because another debugger or extension owns the tab.', 'chrome-policy-blocked': 'Chrome policy blocks debugger or extension access for this profile.', 'stale-or-lost': 'The extension connection or lease is stale/lost. Keep Chrome open; Forge is recovering. Detach and attach again if it does not reconnect.', 'extension-update-required': 'The connected extension is out of date. Update the unpacked extension from External Chrome settings.', 'operation-failed': 'The local Chrome operation failed without changing the confirmed attachment.' }; return <div role="alert" className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{messages[error]}</div> }
function setupMessage(status: ExternalChromeLocalStatus['coordinator'] | undefined): string { if (!status) return 'Status is unavailable. Restart Forge Desktop; no Chrome profile was changed.'; if (status.setup.pathState === 'missing') return 'The pinned unpacked extension is not installed. Open Settings → External Chrome (Local Beta) to set it up.'; if (status.setup.pathState !== 'ready') return 'The local extension payload needs repair or an update in Settings → External Chrome (Local Beta).'; if (status.registration === 'conflict') return 'Native host registration conflicts with another Forge installation. Resolve it in External Chrome settings.'; if (status.state === 'other-instance') return 'Another Forge Desktop instance owns External Chrome. Use that instance or take over only when ownership is stale.'; return 'External Chrome is off by default. Enable the Local Beta in Settings, then connect the intended Chrome profile.' }
function tabKey(instanceId: string, tabId: number): string { return `${instanceId}:${tabId}` }
function splitTabKey(value: string): [string, string] { const index = value.lastIndexOf(':'); return [value.slice(0, index), value.slice(index + 1)] }
function shortId(value: string): string { return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value }
function displayAlias(id: string, fallback: string | undefined, aliases: Record<string, string>): string { return aliases[id]?.trim() || fallback || 'Chrome profile' }
const ALIAS_KEY = 'forge.externalChrome.localAliases.v1'
function readAliases(): Record<string, string> { try { const value = JSON.parse(localStorage.getItem(ALIAS_KEY) ?? '{}') as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key, alias]) => key.length <= 128 && typeof alias === 'string' && alias.length <= 80)) : {} } catch { return {} } }
function setAlias(id: string, value: string, aliases: Record<string, string>, update: (value: Record<string, string>) => void): void { const next = { ...aliases, [id]: value.slice(0, 80) }; if (!next[id]) delete next[id]; update(next); try { localStorage.setItem(ALIAS_KEY, JSON.stringify(next)) } catch { /* local alias remains in memory */ } }

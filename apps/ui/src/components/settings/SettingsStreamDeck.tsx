import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Download,
  Grid3X3,
  Loader2,
  Radio,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import type { StreamDeckSettingsSnapshot } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { StreamDeckPluginStatus } from '@/lib/electron-bridge'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsSection } from './settings-row'

export function SettingsStreamDeck({ apiClient }: { apiClient: SettingsApiClient }) {
  const [snapshot, setSnapshot] = useState<StreamDeckSettingsSnapshot>({ pendingRequests: [], devices: [] })
  const [plugin, setPlugin] = useState<StreamDeckPluginStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await apiClient.fetchJson<StreamDeckSettingsSnapshot>('/api/settings/stream-deck'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load Stream Deck pairing state')
    }
  }, [apiClient])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    void window.electronBridge?.getStreamDeckPluginStatus?.().then(setPlugin)
  }, [])

  const decide = async (requestId: string, decision: 'approve' | 'deny') => {
    setBusy(requestId)
    setMessage(null)
    try {
      await apiClient.fetchJson(`/api/settings/stream-deck/requests/${encodeURIComponent(requestId)}/${decision}`, {
        method: 'POST',
      })
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Pairing decision failed')
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (deviceId: string) => {
    setBusy(deviceId)
    setMessage(null)
    try {
      await apiClient.fetchJson(`/api/settings/stream-deck/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      })
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Device revocation failed')
    } finally {
      setBusy(null)
    }
  }

  const install = async () => {
    const bridge = window.electronBridge
    if (!bridge?.installStreamDeckPlugin) return
    setBusy('install')
    try {
      const result = await bridge.installStreamDeckPlugin()
      setMessage(result.message)
    } finally {
      setBusy(null)
    }
  }

  const openStreamDeck = async () => {
    const bridge = window.electronBridge
    if (!bridge?.openStreamDeck) return
    setBusy('open-stream-deck')
    try {
      const result = await bridge.openStreamDeck()
      setMessage(result.message)
    } finally {
      setBusy(null)
    }
  }

  const activeDevices = snapshot.devices.filter((device) => !device.revokedAt)
  // Older preload bridges do not expose isPackaged; they only occur in source runs.
  const isDevelopmentBuild = plugin !== null && plugin.isPackaged !== true
  const installerDescription = isDevelopmentBuild
    ? 'This development build prepares a real Stream Deck installer before Forge starts, so you can test the same direct-install flow as a release.'
    : 'Forge Desktop bundles the signed direct-distribution package. Stream Deck will ask you to confirm installation and add the layouts for supported devices.'

  return (
    <div className="space-y-7">
      <div className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-[radial-gradient(circle_at_top_right,rgba(57,231,255,0.15),transparent_42%),linear-gradient(135deg,rgba(12,17,32,0.98),rgba(6,8,17,0.98))] p-6 text-slate-100 shadow-2xl">
        <div className="absolute -right-10 -top-12 size-40 rounded-full border border-violet-400/20 shadow-[0_0_60px_rgba(155,108,255,0.2)]" />
        <div className="relative flex items-start gap-4">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-cyan-300/50 bg-cyan-300/10 shadow-[0_0_28px_rgba(57,231,255,0.25)]">
            <Grid3X3 className="size-7 text-cyan-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-black tracking-tight">Forge Command Center</h2>
              <Badge className="border-violet-400/30 bg-violet-400/15 text-violet-200">Agentic surface</Badge>
            </div>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
              Live sessions, questions, unread work, worker swarms, context pressure, statistics,
              Git, Browser, Terminal, and guarded agent controls—rendered directly on your keys.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <Feature icon={<Radio className="size-3" />} label="Live state" />
              <Feature icon={<Sparkles className="size-3" />} label="Animated attention" />
              <Feature icon={<ShieldCheck className="size-3" />} label="Scoped pairing" />
            </div>
          </div>
        </div>
      </div>

      {message ? <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-sm">{message}</div> : null}

      <SettingsSection
        label="Install the native plugin"
        description={installerDescription}
        cta={plugin?.streamDeckInstalled || plugin?.bundled ? (
          <div className="flex flex-wrap gap-2">
            {plugin?.streamDeckInstalled ? <Button variant="outline" className="gap-2" onClick={() => void openStreamDeck()} disabled={busy === 'open-stream-deck'}>
              {busy === 'open-stream-deck' ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
              Open Stream Deck
            </Button> : null}
            {plugin?.bundled ? <Button className="gap-2" onClick={() => void install()} disabled={busy === 'install'}>
              {busy === 'install' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              Install / Update
            </Button> : null}
          </div>
        ) : null}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatusTile
            label={isDevelopmentBuild ? 'Test installer' : 'Forge bundle'}
            ok={plugin?.bundled ?? false}
            detail={plugin?.bundled
              ? `v${plugin.pluginVersion} ready`
              : isDevelopmentBuild
                ? 'Restart pnpm dev:electron to prepare it'
                : 'Available in packaged Forge'}
          />
          <StatusTile label="Stream Deck" ok={plugin?.streamDeckInstalled ?? false} detail={plugin?.streamDeckInstalled ? 'App detected' : 'Install Elgato Stream Deck first'} />
          <StatusTile label="Paired devices" ok={activeDevices.length > 0} detail={`${activeDevices.length} active`} />
        </div>
      </SettingsSection>

      <SettingsSection
        label="Pairing requests"
        description="A six-digit code appears across the Forge keys. Approve only when it matches the code in front of you."
      >
        {snapshot.pendingRequests.length === 0 ? (
          <EmptyState text={isDevelopmentBuild
            ? 'Install the test plugin, open Stream Deck, and switch to the Forge Command Center keys. They will show a six-digit code; return here and pair the matching request.'
            : 'Open Stream Deck after installing the plugin. New pairing requests appear here automatically.'}
          />
        ) : snapshot.pendingRequests.map((request) => (
          <div key={request.requestId} className="flex flex-col gap-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{request.deviceName}</span>
                <Badge variant="outline">Plugin {request.pluginVersion}</Badge>
              </div>
              <div className="mt-2 font-mono text-2xl font-black tracking-[0.25em] text-amber-500">
                {request.verificationCode.slice(0, 3)} {request.verificationCode.slice(3)}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="gap-1.5" disabled={busy === request.requestId} onClick={() => void decide(request.requestId, 'deny')}>
                <X className="size-4" /> Deny
              </Button>
              <Button className="gap-1.5" disabled={busy === request.requestId} onClick={() => void decide(request.requestId, 'approve')}>
                {busy === request.requestId ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Pair
              </Button>
            </div>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        label="Paired devices"
        description="Each device receives its own Forge Stream Deck credential. It cannot authenticate the Forge CLI and can be revoked independently."
      >
        {activeDevices.length === 0 ? <EmptyState text="No Stream Deck devices are paired yet." /> : activeDevices.map((device) => (
          <div key={device.id} className="flex items-center gap-3 rounded-xl border bg-card/50 p-4">
            <div className="grid size-10 place-items-center rounded-lg bg-emerald-500/10 text-emerald-500"><Grid3X3 className="size-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{device.deviceName}</div>
              <div className="text-xs text-muted-foreground">Plugin {device.pluginVersion} · paired {new Date(device.createdAt).toLocaleDateString()}</div>
            </div>
            <Button variant="ghost" size="sm" className="gap-1.5 text-destructive" disabled={busy === device.id} onClick={() => void revoke(device.id)}>
              <Trash2 className="size-4" /> Revoke
            </Button>
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}

function Feature({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">{icon}{label}</span>
}

function StatusTile({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return <div className="rounded-xl border bg-card/40 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><span className={`size-2 rounded-full ${ok ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,.6)]' : 'bg-muted-foreground/40'}`} />{label}</div><div className="mt-1 text-xs text-muted-foreground">{detail}</div></div>
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{text}</div>
}

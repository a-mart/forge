import streamDeck from '@elgato/streamdeck'
import type { KeyAction } from '@elgato/streamdeck'
import { renderKey, renderPairingKey, resolveSession } from './artwork.js'
import { ForgeClient, ForgeHttpError } from './forge-client.js'
import type {
  ForgeActionKind,
  ForgeActionSettings,
  ForgeGlobalSettings,
  StreamDeckActionRequest,
  StreamDeckSnapshot,
  VisibleForgeAction,
} from './types.js'

const DEFAULT_POLL_MS = 1_500

export class ForgeDeckController {
  private readonly visible = new Map<string, VisibleForgeAction>()
  private readonly pressedAt = new Map<string, number>()
  private readonly renderedImages = new Map<string, string>()
  private readonly client = new ForgeClient(
    async () => streamDeck.settings.getGlobalSettings<ForgeGlobalSettings>(),
  )
  private snapshot: StreamDeckSnapshot | null = null
  private frame = 0
  private connected = false
  private credentialAvailable = false
  private pollInFlight = false
  private pollTimer: NodeJS.Timeout | null = null
  private animationTimer: NodeJS.Timeout | null = null
  private pairing: { requestId: string; claimSecret: string; code: string; expiresAt: string } | null = null
  private pairingInFlight = false

  start(): void {
    streamDeck.settings.onDidReceiveGlobalSettings(() => {
      this.schedulePoll(0)
    })
    streamDeck.system.onSystemDidWakeUp(() => this.schedulePoll(0))
    streamDeck.system.onDidReceiveDeepLink((event) => {
      if (event.url.path === '/refresh' || event.url.path === '/diagnostics') {
        this.schedulePoll(0)
      }
    })
    this.animationTimer = setInterval(() => {
      this.frame = (this.frame + 1) % 120
      if (this.hasAnimatedState()) void this.renderAll()
    }, 550)
    this.animationTimer.unref?.()
    this.schedulePoll(0)
  }

  register(
    action: KeyAction,
    manifestId: string,
    kind: ForgeActionKind,
    settings: ForgeActionSettings,
  ): void {
    this.visible.set(action.id, { id: action.id, manifestId, kind, action, settings })
    void this.render(this.visible.get(action.id)!)
    this.schedulePoll(0)
  }

  update(actionId: string, settings: ForgeActionSettings): void {
    const current = this.visible.get(actionId)
    if (!current) return
    current.settings = settings
    void this.render(current)
    this.schedulePoll(0)
  }

  unregister(actionId: string): void {
    this.visible.delete(actionId)
    this.pressedAt.delete(actionId)
    this.renderedImages.delete(actionId)
  }

  keyDown(actionId: string): void {
    this.pressedAt.set(actionId, Date.now())
  }

  async keyUp(actionId: string): Promise<void> {
    const visible = this.visible.get(actionId)
    if (!visible) return
    const heldMs = Date.now() - (this.pressedAt.get(actionId) ?? Date.now())
    this.pressedAt.delete(actionId)

    try {
      await this.execute(visible, heldMs)
      streamDeck.logger.info(`Forge action succeeded: ${visible.kind}`)
      await visible.action.showOk()
      this.schedulePoll(150)
    } catch (error) {
      streamDeck.logger.error(`Forge action failed: ${error instanceof Error ? error.message : String(error)}`)
      await visible.action.showAlert()
      this.connected = false
      if (error instanceof ForgeHttpError && (error.status === 401 || error.status === 403)) {
        await this.clearAccessToken()
      }
      await this.render(visible)
    }
  }

  private async execute(visible: VisibleForgeAction, heldMs: number): Promise<void> {
    if (!this.snapshot) throw new Error('Forge is not connected')
    const session = resolveSession(this.snapshot, visible.settings)
    const requiresHold =
      visible.kind === 'control' ||
      visible.kind === 'context' ||
      visible.kind === 'new-session'
    if (requiresHold && heldMs < 650) {
      throw new Error('Hold the key to execute')
    }

    if (visible.kind === 'view') {
      await this.navigate(session?.agentId ?? null, visible.settings.view ?? 'git')
      return
    }
    if (visible.kind === 'stats') {
      await this.navigate(session?.agentId ?? null, 'stats')
      return
    }
    if (visible.kind === 'pulse' || visible.kind === 'session' || visible.kind === 'attention' || visible.kind === 'workers') {
      await this.navigate(session?.agentId ?? null, 'chat')
      return
    }
    if (visible.kind === 'mission') {
      if (!session) throw new Error('No target session')
      const text = visible.settings.prompt?.trim()
      if (!text) throw new Error('Configure a mission prompt')
      await this.perform({
        requestId: requestId(),
        type: 'send_prompt',
        sessionAgentId: session.agentId,
        text,
        delivery: 'auto',
      })
      return
    }
    if (visible.kind === 'context') {
      if (!session) throw new Error('No target session')
      await this.perform({
        requestId: requestId(),
        type: 'smart_compact',
        sessionAgentId: session.agentId,
      })
      return
    }
    if (visible.kind === 'control') {
      if (!session) throw new Error('No target session')
      const control = visible.settings.control ?? 'toggle'
      await this.perform({
        requestId: requestId(),
        type: control === 'compact' ? 'smart_compact' : control === 'mark_read' ? 'mark_read' : 'toggle_session',
        sessionAgentId: session.agentId,
      })
      return
    }
    if (visible.kind === 'new-session') {
      const profileId = visible.settings.targetProfileId ?? this.snapshot.profiles[0]?.profileId
      if (!profileId) throw new Error('No target profile')
      const response = await this.perform({
        requestId: requestId(),
        type: 'create_session',
        profileId,
        ...(visible.settings.label?.trim() ? { label: visible.settings.label.trim() } : {}),
      })
      if (response.ok && response.sessionAgentId) {
        await this.navigate(response.sessionAgentId, 'chat')
      }
    }
  }

  private async navigate(
    sessionAgentId: string | null,
    surface: NonNullable<ForgeActionSettings['view']>,
  ): Promise<void> {
    await this.perform({
      requestId: requestId(),
      type: 'navigate',
      surface,
      ...(sessionAgentId ? { sessionAgentId } : {}),
    })
  }

  private async perform(action: StreamDeckActionRequest) {
    const response = await this.client.perform(action)
    if (!response.ok) throw new Error(response.message)
    return response
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.poll(), delayMs)
    this.pollTimer.unref?.()
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true
    let interval = DEFAULT_POLL_MS
    try {
      const settings = await streamDeck.settings.getGlobalSettings<ForgeGlobalSettings>()
      this.credentialAvailable = hasCredential(settings)
      interval = clampPollInterval(settings.pollIntervalMs)
      this.snapshot = await this.client.getSnapshot()
      this.connected = true
      await this.renderAll()
    } catch (error) {
      if (this.connected) {
        streamDeck.logger.warn(`Forge disconnected: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.connected = false
      if (error instanceof ForgeHttpError && (error.status === 401 || error.status === 403)) {
        await this.clearAccessToken()
      }
      await this.ensurePairing()
      await this.renderAll()
    } finally {
      this.pollInFlight = false
      this.schedulePoll(interval)
    }
  }

  private async renderAll(): Promise<void> {
    await Promise.all(Array.from(this.visible.values(), (entry) => this.render(entry)))
  }

  private async render(entry: VisibleForgeAction): Promise<void> {
    const svg = !this.credentialAvailable
      ? renderPairingKey(entry.kind, this.pairing?.code ?? null)
      : renderKey(entry.kind, this.snapshot, entry.settings, this.frame, this.connected)
    const image = `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`
    if (this.renderedImages.get(entry.id) === image) return
    await entry.action.setImage(image)
    this.renderedImages.set(entry.id, image)
  }

  private hasAnimatedState(): boolean {
    if (!this.snapshot || this.visible.size === 0) return false
    return this.snapshot.summary.pendingChoiceCount > 0
  }

  private async ensurePairing(): Promise<void> {
    if (this.pairingInFlight) return
    const settings = await streamDeck.settings.getGlobalSettings<ForgeGlobalSettings>()
    this.credentialAvailable = hasCredential(settings)
    if (this.credentialAvailable) return
    this.pairingInFlight = true
    try {
      if (!this.pairing || Date.parse(this.pairing.expiresAt) <= Date.now()) {
        const deviceId = settings.deviceId?.trim() || `deck-${crypto.randomUUID()}`
        const created = await this.client.createPairing({
          deviceId,
          deviceName: 'Forge Command Center',
          pluginVersion: '0.2.1.0',
        })
        this.pairing = {
          requestId: created.requestId,
          claimSecret: created.claimSecret,
          code: created.verificationCode,
          expiresAt: created.expiresAt,
        }
        await streamDeck.settings.setGlobalSettings<ForgeGlobalSettings>({
          ...settings,
          deviceId,
          pairingRequestId: created.requestId,
          pairingCode: created.verificationCode,
          pairingExpiresAt: created.expiresAt,
        })
        await this.renderAll()
      }
      const result = await this.client.claimPairing(this.pairing.requestId, this.pairing.claimSecret)
      if (result.status === 'approved') {
        const current = await streamDeck.settings.getGlobalSettings<ForgeGlobalSettings>()
        await streamDeck.settings.setGlobalSettings<ForgeGlobalSettings>({
          ...current,
          accessToken: result.accessToken,
          pairingRequestId: undefined,
          pairingCode: undefined,
          pairingExpiresAt: undefined,
        })
        this.credentialAvailable = true
        this.pairing = null
        this.schedulePoll(0)
      } else if (result.status === 'denied') {
        this.pairing = null
      }
    } catch {
      // Forge may not be running yet; the normal poll loop retries.
    } finally {
      this.pairingInFlight = false
    }
  }

  private async clearAccessToken(): Promise<void> {
    const settings = await streamDeck.settings.getGlobalSettings<ForgeGlobalSettings>()
    if (!settings.accessToken) return
    await streamDeck.settings.setGlobalSettings<ForgeGlobalSettings>({
      ...settings,
      accessToken: undefined,
    })
    this.credentialAvailable = hasCredential({ ...settings, accessToken: undefined })
  }

}

function requestId(): string {
  return `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function clampPollInterval(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_POLL_MS
  return Math.min(10_000, Math.max(750, Math.round(value)))
}

function hasCredential(settings: ForgeGlobalSettings): boolean {
  return Boolean(settings.accessToken?.trim() || settings.apiKey?.trim())
}

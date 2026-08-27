import {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from '@elgato/streamdeck'
import type { ForgeDeckController } from './controller.js'
import type { ForgeActionKind, ForgeActionSettings } from './types.js'

abstract class ForgeAction extends SingletonAction<ForgeActionSettings> {
  protected abstract readonly kind: ForgeActionKind

  constructor(private readonly controller: ForgeDeckController) {
    super()
  }

  onWillAppear(event: WillAppearEvent<ForgeActionSettings>): void {
    if (!event.action.isKey()) return
    this.controller.register(event.action, this.kind, event.payload.settings)
  }

  onWillDisappear(event: WillDisappearEvent<ForgeActionSettings>): void {
    this.controller.unregister(event.action.id)
  }

  onDidReceiveSettings(event: DidReceiveSettingsEvent<ForgeActionSettings>): void {
    this.controller.update(event.action.id, event.payload.settings)
  }

  onKeyDown(event: KeyDownEvent<ForgeActionSettings>): void {
    this.controller.keyDown(event.action.id)
  }

  async onKeyUp(event: KeyUpEvent<ForgeActionSettings>): Promise<void> {
    await this.controller.keyUp(event.action.id)
  }
}

@action({ UUID: 'com.forge.command-center.pulse' })
export class PulseAction extends ForgeAction {
  protected readonly kind = 'pulse'
}

@action({ UUID: 'com.forge.command-center.session' })
export class SessionAction extends ForgeAction {
  protected readonly kind = 'session'
}

@action({ UUID: 'com.forge.command-center.attention' })
export class AttentionAction extends ForgeAction {
  protected readonly kind = 'attention'
}

@action({ UUID: 'com.forge.command-center.workers' })
export class WorkersAction extends ForgeAction {
  protected readonly kind = 'workers'
}

@action({ UUID: 'com.forge.command-center.context' })
export class ContextAction extends ForgeAction {
  protected readonly kind = 'context'
}

@action({ UUID: 'com.forge.command-center.stats' })
export class StatsAction extends ForgeAction {
  protected readonly kind = 'stats'
}

@action({ UUID: 'com.forge.command-center.view' })
export class ViewAction extends ForgeAction {
  protected readonly kind = 'view'
}

@action({ UUID: 'com.forge.command-center.mission' })
export class MissionAction extends ForgeAction {
  protected readonly kind = 'mission'
}

@action({ UUID: 'com.forge.command-center.control' })
export class ControlAction extends ForgeAction {
  protected readonly kind = 'control'
}

@action({ UUID: 'com.forge.command-center.new-session' })
export class NewSessionAction extends ForgeAction {
  protected readonly kind = 'new-session'
}

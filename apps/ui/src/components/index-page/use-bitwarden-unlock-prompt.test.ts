/** @vitest-environment jsdom */

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureSecretsCatalog } from '@/lib/secure-secrets-api'
import {
  findLockedBitwardenPasswordManager,
  useBitwardenUnlockPrompt,
} from './use-bitwarden-unlock-prompt'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const lockedCatalog: SecureSecretsCatalog = {
  providers: [{
    providerId: 'bitwarden-password-manager',
    kind: 'bitwarden_password_manager',
    displayName: 'Bitwarden Password Manager',
    enabled: true,
    status: 'locked',
    lastVerifiedAt: null,
    lastStatusCode: 'source_locked',
  }],
  secrets: [],
  projectDefaults: [],
  sshTrustedHosts: [],
}

type PromptController = ReturnType<typeof useBitwardenUnlockPrompt>

let container: HTMLDivElement
let root: Root
let controller: PromptController

function captureController(next: PromptController): void {
  controller = next
}

function Harness({
  catalog = lockedCatalog,
  active = true,
  canUnlock = true,
  unlock,
  onController,
}: {
  catalog?: SecureSecretsCatalog | null
  active?: boolean
  canUnlock?: boolean
  unlock: (providerId: string, masterPassword: string) => Promise<void>
  onController: (controller: PromptController) => void
}) {
  const nextController = useBitwardenUnlockPrompt({ catalog, active, canUnlock, unlock })
  useEffect(() => {
    onController(nextController)
  }, [nextController, onController])
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useBitwardenUnlockPrompt', () => {
  it('prompts once at launch and re-prompts when starting a secure session', async () => {
    const unlock = vi.fn(async () => undefined)
    await act(async () => {
      root.render(createElement(Harness, { unlock, onController: captureController }))
    })

    expect(controller.prompt).toMatchObject({
      providerId: 'bitwarden-password-manager',
      reason: 'launch',
    })
    act(() => controller.dismissPrompt())
    expect(controller.prompt).toBeNull()

    let startResult!: Promise<boolean>
    act(() => {
      startResult = controller.ensureUnlocked()
    })
    expect(controller.prompt?.reason).toBe('secure_session')

    await act(async () => {
      await controller.unlockPrompt('synthetic-master-password')
    })
    await expect(startResult).resolves.toBe(true)
    expect(unlock).toHaveBeenCalledWith(
      'bitwarden-password-manager',
      'synthetic-master-password',
    )
    expect(controller.prompt).toBeNull()
  })

  it('cancels a pending secure-session start without invoking unlock', async () => {
    const unlock = vi.fn(async () => undefined)
    await act(async () => {
      root.render(createElement(Harness, { unlock, onController: captureController }))
    })
    act(() => controller.dismissPrompt())

    let startResult!: Promise<boolean>
    act(() => {
      startResult = controller.ensureUnlocked()
    })
    act(() => controller.dismissPrompt())

    await expect(startResult).resolves.toBe(false)
    expect(unlock).not.toHaveBeenCalled()
  })

  it('continues immediately when the configured provider is already available', async () => {
    const availableCatalog: SecureSecretsCatalog = {
      ...lockedCatalog,
      providers: lockedCatalog.providers.map((provider) => ({
        ...provider,
        status: 'available',
      })),
    }
    const unlock = vi.fn(async () => undefined)
    await act(async () => {
      root.render(createElement(Harness, {
        catalog: availableCatalog,
        unlock,
        onController: captureController,
      }))
    })

    expect(findLockedBitwardenPasswordManager(availableCatalog)).toBeNull()
    await expect(controller.ensureUnlocked()).resolves.toBe(true)
    expect(controller.prompt).toBeNull()
  })
})

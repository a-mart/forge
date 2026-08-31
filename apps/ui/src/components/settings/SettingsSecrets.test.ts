/** @vitest-environment jsdom */

import {
  fireEvent,
  getByLabelText,
  getByRole,
  getByText,
  queryByRole,
  waitFor,
} from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsSecrets } from './SettingsSecrets'
import { SECURE_SECRET_MAX_PROJECT_DEFAULTS } from '@forge/protocol'

const secureSecretsApiMock = vi.hoisted(() => ({
  fetchSecureSecretsCatalog: vi.fn(),
  fetchSecureSessionReadiness: vi.fn(),
  installSecureRunner: vi.fn(),
  createLocalSecret: vi.fn(),
  updateSecureSecret: vi.fn(),
  updateSecureSecretAutomaticGrant: vi.fn(),
  updateSecureSecretProjectDefault: vi.fn(),
  deleteSecureSecret: vi.fn(),
  connectBitwardenProvider: vi.fn(),
  reconnectBitwardenProvider: vi.fn(),
  importBitwardenSecret: vi.fn(),
  testSecureSecretProvider: vi.fn(),
  disconnectSecureSecretProvider: vi.fn(),
  exportSecureVaultTransfer: vi.fn(),
  importSecureVaultTransfer: vi.fn(),
  createSecureSshTrustedHost: vi.fn(),
  updateSecureSshTrustedHost: vi.fn(),
  deleteSecureSshTrustedHost: vi.fn(),
  isSecureMaterialEntryAvailable: vi.fn(() => true),
  checkSecureMaterialEntryAvailability: vi.fn(async () => true),
  unlockSecureMaterialEntry: vi.fn(async () => true),
}))

vi.mock('@/lib/secure-secrets-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/secure-secrets-api')>()
  return {
    ...original,
    fetchSecureSecretsCatalog: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSecretsCatalog(...args),
    fetchSecureSessionReadiness: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSessionReadiness(...args),
    installSecureRunner: (...args: unknown[]) =>
      secureSecretsApiMock.installSecureRunner(...args),
    createLocalSecret: (...args: unknown[]) =>
      secureSecretsApiMock.createLocalSecret(...args),
    updateSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecret(...args),
    updateSecureSecretAutomaticGrant: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecretAutomaticGrant(...args),
    updateSecureSecretProjectDefault: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecretProjectDefault(...args),
    deleteSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.deleteSecureSecret(...args),
    connectBitwardenProvider: (...args: unknown[]) =>
      secureSecretsApiMock.connectBitwardenProvider(...args),
    reconnectBitwardenProvider: (...args: unknown[]) =>
      secureSecretsApiMock.reconnectBitwardenProvider(...args),
    importBitwardenSecret: (...args: unknown[]) =>
      secureSecretsApiMock.importBitwardenSecret(...args),
    testSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.testSecureSecretProvider(...args),
    disconnectSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.disconnectSecureSecretProvider(...args),
    exportSecureVaultTransfer: (...args: unknown[]) =>
      secureSecretsApiMock.exportSecureVaultTransfer(...args),
    importSecureVaultTransfer: (...args: unknown[]) =>
      secureSecretsApiMock.importSecureVaultTransfer(...args),
    createSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.createSecureSshTrustedHost(...args),
    updateSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSshTrustedHost(...args),
    deleteSecureSshTrustedHost: (...args: unknown[]) =>
      secureSecretsApiMock.deleteSecureSshTrustedHost(...args),
    isSecureMaterialEntryAvailable: () =>
      secureSecretsApiMock.isSecureMaterialEntryAvailable(),
    checkSecureMaterialEntryAvailability: () =>
      secureSecretsApiMock.checkSecureMaterialEntryAvailability(),
    unlockSecureMaterialEntry: () =>
      secureSecretsApiMock.unlockSecureMaterialEntry(),
  }
})

const LOCAL_PROVIDER = {
  providerId: 'local',
  kind: 'local_keychain' as const,
  displayName: 'Local vault',
  enabled: true,
  status: 'available' as const,
  lastVerifiedAt: null,
  lastStatusCode: null,
}

const SECRET_SUMMARY = {
  secretId: 'secret-1',
  displayAlias: 'github/work',
  displayName: 'GitHub work token',
  note: 'Used by release automation.',
  providerId: 'local',
  scope: { kind: 'instance' as const },
  retention: 'saved' as const,
  bindings: [],
  available: true,
  updatedAt: '2026-07-23T12:00:00.000Z',
}

const BITWARDEN_PROVIDER = {
  ...LOCAL_PROVIDER,
  providerId: 'bitwarden-1',
  kind: 'bitwarden_secrets_manager' as const,
  displayName: 'Bitwarden work',
}

const VAULT_TRANSFER = {
  bundle: {
    format: 'forge-secure-vault-transfer' as const,
    version: 1 as const,
    algorithm: 'aes-256-gcm' as const,
    createdAt: '2026-08-31T12:00:00.000Z',
    itemCount: 2,
    nonce: 'A'.repeat(16),
    authTag: 'B'.repeat(22),
    ciphertext: btoa('encrypted-transfer'),
  },
  transferCode: 'C'.repeat(43),
  localSecretCount: 1,
  providerCredentialCount: 1,
}

const PROFILES = [
  {
    profileId: 'project-alpha',
    displayName: 'Alpha Project',
    defaultSessionAgentId: 'alpha-session',
    defaultModel: { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z',
  },
  {
    profileId: 'project-beta',
    displayName: 'Beta Project',
    defaultSessionAgentId: 'beta-session',
    defaultModel: { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z',
  },
]

let container: HTMLDivElement
let root: Root | null = null
const clipboardWriteText = vi.fn(async (_value: string) => undefined)

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false,
    },
    setPointerCapture: {
      configurable: true,
      value: () => {},
    },
    releasePointerCapture: {
      configurable: true,
      value: () => {},
    },
    scrollIntoView: {
      configurable: true,
      value: () => {},
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteText },
  })
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value: vi.fn(() => 'blob:forge-vault-transfer'),
    },
    revokeObjectURL: {
      configurable: true,
      value: vi.fn(),
    },
  })
  secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(true)
  secureSecretsApiMock.isSecureMaterialEntryAvailable.mockReturnValue(true)
  secureSecretsApiMock.unlockSecureMaterialEntry.mockReset()
  secureSecretsApiMock.unlockSecureMaterialEntry.mockResolvedValue(true)
  secureSecretsApiMock.fetchSecureSessionReadiness.mockResolvedValue({
    available: false,
    code: 'image_unavailable',
  })
  secureSecretsApiMock.testSecureSecretProvider.mockReset()
  secureSecretsApiMock.testSecureSecretProvider.mockResolvedValue({
    provider: LOCAL_PROVIDER,
    code: 'ok',
    affectedSecrets: [],
  })
  secureSecretsApiMock.exportSecureVaultTransfer.mockReset()
  secureSecretsApiMock.importSecureVaultTransfer.mockReset()
  secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
    providers: [LOCAL_PROVIDER],
    secrets: [],
    projectDefaults: [],
    sshTrustedHosts: [],
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function makeClient(kind: 'builder' | 'collab' = 'builder'): SettingsApiClient {
  return {
    target: {
      kind,
      label: kind,
      description: kind,
      wsUrl: kind === 'builder' ? 'ws://127.0.0.1:47187' : 'wss://remote.example.test',
      apiBaseUrl: kind === 'builder'
        ? 'http://127.0.0.1:47187/'
        : 'https://remote.example.test/',
      fetchCredentials: kind === 'builder' ? 'same-origin' : 'include',
      requiresAdmin: kind === 'collab',
      availableTabs: [],
    },
    endpoint: (path) => path,
    fetch: vi.fn(),
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function render(
  client = makeClient(),
  currentProfileId: string | undefined = 'project-alpha',
): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsSecrets, {
      apiClient: client,
      profiles: PROFILES,
      ...(currentProfileId ? { currentProfileId } : {}),
    }))
  })
}

describe('SettingsSecrets', () => {
  it('never loads secure settings for a remote origin', () => {
    render(makeClient('collab'))

    expect(container.textContent).toContain('Local Builder only')
    expect(container.textContent).toContain('disabled for remote origins')
    expect(secureSecretsApiMock.fetchSecureSecretsCatalog).not.toHaveBeenCalled()
  })

  it('opens saved secrets by default when Secure Sessions are ready', async () => {
    secureSecretsApiMock.fetchSecureSessionReadiness.mockResolvedValue({
      available: true,
      code: 'available',
    })
    render()

    await waitFor(() => {
      expect(getByRole(container, 'tab', { name: 'Secrets' })
        .getAttribute('data-state')).toBe('active')
      expect(container.textContent).toContain('Add local secret')
    })
  })

  it('keeps sources first while Secure Sessions are not ready', async () => {
    render()

    await waitFor(() => {
      expect(getByRole(container, 'tab', { name: 'Sources' })
        .getAttribute('data-state')).toBe('active')
      expect(container.textContent).toContain('Private sources')
    })
  })

  it('exports and imports one encrypted Desktop vault transfer without retaining the import code', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    secureSecretsApiMock.exportSecureVaultTransfer.mockResolvedValue(VAULT_TRANSFER)
    secureSecretsApiMock.importSecureVaultTransfer.mockResolvedValue({
      importedItemCount: 2,
      localSecretCount: 1,
      providerCredentialCount: 1,
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Move vault to another machine')).toBeTruthy()
    })
    fireEvent.click(getByText(container, 'Move vault to another machine'))
    fireEvent.click(getByRole(container, 'button', { name: 'Export transfer file' }))

    const exportedCode = await waitFor(() => getByLabelText(
      container,
      'Exported vault transfer code',
    ) as HTMLInputElement)
    expect(exportedCode.value).toBe(VAULT_TRANSFER.transferCode)
    expect(anchorClick).toHaveBeenCalledOnce()
    fireEvent.click(getByRole(container, 'button', { name: 'Copy code' }))
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(VAULT_TRANSFER.transferCode)
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Hide code' }))

    const file = new File(
      [JSON.stringify(VAULT_TRANSFER.bundle)],
      'migration.forge-vault-transfer',
      { type: 'application/json' },
    )
    const fileInput = getByLabelText(container, 'Transfer file') as HTMLInputElement
    const codeInput = getByLabelText(container, 'Transfer code') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })
    fireEvent.change(codeInput, { target: { value: VAULT_TRANSFER.transferCode } })
    fireEvent.click(getByRole(container, 'button', { name: 'Import transfer file' }))

    await waitFor(() => {
      expect(codeInput.value).toBe('')
      expect(secureSecretsApiMock.importSecureVaultTransfer).toHaveBeenCalledWith(
        expect.anything(),
        {
          bundle: VAULT_TRANSFER.bundle,
          transferCode: VAULT_TRANSFER.transferCode,
        },
      )
      expect(container.textContent).toContain('2 vault items were transferred')
    })
    expect(container.innerHTML).not.toContain(VAULT_TRANSFER.transferCode)
  })

  it('adds a project-scoped trusted SSH host from the SSH hosts tab', async () => {
    secureSecretsApiMock.createSecureSshTrustedHost.mockResolvedValue({
      trustedHostId: 'ssh-host-1',
      profileId: 'project-alpha',
      alias: 'production-api',
      hostName: '10.0.0.25',
      port: 22,
      username: 'deploy',
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:trusted',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
    })
    render()

    await waitFor(() => {
      expect(getByRole(container, 'tab', { name: 'SSH hosts' })).toBeTruthy()
    })
    activateTab('SSH hosts')

    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: 'production-api' },
    })
    fireEvent.change(getByLabelText(container, 'Host or address'), {
      target: { value: '10.0.0.25' },
    })
    fireEvent.change(getByLabelText(container, 'Username'), {
      target: { value: 'deploy' },
    })
    fireEvent.change(getByLabelText(container, 'Trusted public host key'), {
      target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Trust host' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.createSecureSshTrustedHost).toHaveBeenCalledWith(
        expect.anything(),
        {
          profileId: 'project-alpha',
          alias: 'production-api',
          hostName: '10.0.0.25',
          port: 22,
          username: 'deploy',
          hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA',
        },
      )
    })
  })

  it('shows an actionable inline error for an incomplete SSH host', async () => {
    render()

    await waitFor(() => {
      expect(getByRole(container, 'tab', { name: 'SSH hosts' })).toBeTruthy()
    })
    activateTab('SSH hosts')
    fireEvent.click(getByRole(container, 'button', { name: 'Trust host' }))

    await waitFor(() => {
      expect(getByRole(container, 'alert').textContent).toContain(
        'Enter a project, alias, host, username, valid port, and public host key.',
      )
    })
    expect(secureSecretsApiMock.createSecureSshTrustedHost).not.toHaveBeenCalled()
  })

  it('separates stored sources and bindings from task grants', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [SECRET_SUMMARY],
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    expect(container.textContent).toContain(
      'Catalog availability does not grant access',
    )

    activateTab('Advanced delivery')
    expect(container.textContent).toContain('Delivery never grants task access by itself')
    expect(container.textContent).toContain('generated environment delivery')
  })

  it('identifies the browser and offers pairing from settings', async () => {
    const client = makeClient()
    vi.mocked(client.fetch).mockImplementation(async (path) => {
      if (path === '/api/secure-browser-control/status') {
        return new Response(JSON.stringify({
          available: true,
          authorized: false,
          privateEntryAvailable: false,
          secureContextRequired: false,
          privateEntryTransport: 'trusted_http',
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    render(client)

    await waitFor(() => {
      expect(container.textContent).toContain(
        'You are viewing Forge in a web browser',
      )
      expect(container.textContent).toContain('Trusted network mode')
      expect(getByRole(container, 'button', {
        name: 'Pair this browser',
      })).toBeTruthy()
    })
  })

  it('keeps browser access visible when the Desktop pairing bridge is unavailable', async () => {
    const client = makeClient()
    vi.mocked(client.fetch).mockImplementation(async (path) => {
      if (path === '/api/secure-browser-control/status') {
        return new Response(JSON.stringify({
          available: false,
          authorized: false,
          privateEntryAvailable: false,
          secureContextRequired: false,
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    render(client)

    await waitFor(() => {
      expect(container.textContent).toContain(
        'You are viewing Forge in a web browser',
      )
      expect(container.textContent).toContain(
        'Pairing is unavailable from the backend this browser reached',
      )
      expect(queryByRole(container, 'button', {
        name: 'Pair this browser',
      })).toBeNull()
    })
  })

  it('treats an approved browser as a private-entry surface for the local Builder', async () => {
    vi.stubGlobal('crypto', {
      subtle: { deriveKey: vi.fn() },
    })
    secureSecretsApiMock.isSecureMaterialEntryAvailable.mockReturnValue(false)
    secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(false)
    const client = makeClient()
    vi.mocked(client.fetch).mockImplementation(async (path) => {
      if (path === '/api/secure-browser-control/status') {
        return new Response(JSON.stringify({
          available: true,
          authorized: true,
          privateEntryAvailable: true,
          secureContextRequired: false,
          device: {
            id: 'device-1',
            deviceId: 'browser-installation-1',
            deviceName: 'Forge browser on macOS',
            createdAt: '2026-07-28T16:00:00.000Z',
          },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    render(client)

    await waitFor(() => {
      expect(container.textContent).toContain(
        'Paired as Forge browser on macOS',
      )
      expect(container.textContent).toContain(
        'stays paired for up to 90 days',
      )
      expect(container.textContent).toContain('Private entry')
      expect(container.textContent).toContain('Available')
    })
    activateTab('Secrets')
    expect((
      getByLabelText(container, 'Private value') as HTMLInputElement
    ).disabled).toBe(false)
  })

  it('unlocks private storage in place and supports cancel then retry', async () => {
    secureSecretsApiMock.checkSecureMaterialEntryAvailability
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    secureSecretsApiMock.unlockSecureMaterialEntry
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    render()

    const unlockButton = await waitFor(() => {
      const button = getByRole(
        container,
        'button',
        { name: 'Unlock private storage' },
      ) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      return button
    })
    fireEvent.click(unlockButton)
    await waitFor(() => {
      expect(secureSecretsApiMock.unlockSecureMaterialEntry).toHaveBeenCalledTimes(1)
    })
    await expect(
      secureSecretsApiMock.unlockSecureMaterialEntry.mock.results[0]?.value,
    ).resolves.toBe(false)
    await waitFor(() => {
      expect(container.textContent).toContain('Private storage is still locked')
    })
    expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(1)

    fireEvent.click(getByRole(container, 'button', {
      name: 'Unlock private storage',
    }))
    await waitFor(() => {
      expect(container.textContent).toContain(
        'Private storage is unlocked and the local vault is ready.',
      )
      expect(queryByRole(container, 'button', {
        name: 'Unlock private storage',
      })).toBeNull()
    })
    expect(secureSecretsApiMock.testSecureSecretProvider).toHaveBeenCalledWith(
      expect.anything(),
      LOCAL_PROVIDER.providerId,
    )
    expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
  })

  it('keeps copied-data recovery actionable when unlock finds unreadable values', async () => {
    secureSecretsApiMock.checkSecureMaterialEntryAvailability
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    secureSecretsApiMock.testSecureSecretProvider.mockResolvedValueOnce({
      provider: {
        ...LOCAL_PROVIDER,
        status: 'locked',
        lastStatusCode: 'source_locked',
      },
      code: 'local_secret_decrypt_failed',
      affectedSecrets: [{
        secretId: 'secret-1',
        displayAlias: 'github/work',
      }],
    })
    render()

    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Test vault' })).toBeTruthy()
    })
    fireEvent.click(await waitFor(() => getByRole(container, 'button', {
      name: 'Unlock private storage',
    })))

    await waitFor(() => {
      expect(container.textContent).toContain(
        'Private storage is unlocked, but some saved values need attention.',
      )
      expect(container.textContent).toContain('Use Test vault below to recover them.')
    })
  })

  it('installs a missing secure runner and keeps diagnostics bounded', async () => {
    secureSecretsApiMock.fetchSecureSessionReadiness.mockResolvedValue({
      available: false,
      code: 'image_unavailable',
      unsafeException: 'docker-command-output-canary',
    })
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [{
        ...BITWARDEN_PROVIDER,
        status: 'auth_required',
        lastStatusCode: 'provider_auth_required',
        serverOrigin: 'https://provider-detail-canary.example',
        organizationId: 'organization-detail-canary',
      }],
      secrets: [],
      projectDefaults: [{
        profileId: 'project-alpha',
        secretId: 'secret-id-canary',
        createdAt: '2026-07-24T12:00:00.000Z',
        updatedAt: '2026-07-24T12:00:00.000Z',
      }],
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Secure Sessions readiness')).toBeTruthy()
      expect(container.textContent).toContain('Secure image unavailable')
      expect(container.textContent).toContain('Reconnect the affected source below.')
    })
    secureSecretsApiMock.installSecureRunner.mockResolvedValue({
      available: true,
      code: 'available',
    })
    fireEvent.click(getByRole(container, 'button', {
      name: 'Install secure runner',
    }))
    await waitFor(() => {
      expect(secureSecretsApiMock.installSecureRunner).toHaveBeenCalledOnce()
      expect(container.textContent).toContain(
        'Secure runner installed. Secure Bash is ready.',
      )
    })
    fireEvent.click(getByRole(container, 'button', {
      name: 'Copy safe diagnostics',
    }))

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(1)
    })
    const serialized = String(clipboardWriteText.mock.calls[0]?.[0])
    const diagnostics = JSON.parse(serialized)
    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      execution: { code: 'available' },
      privateEntry: { available: true },
      sources: [{
        kind: 'bitwarden_secrets_manager',
        status: 'auth_required',
        statusCode: 'provider_auth_required',
      }],
      projectDefaults: [{ state: 'configured', statusCode: 'ok' }],
    })
    expect(Object.keys(diagnostics).sort()).toEqual([
      'checkedAt',
      'execution',
      'privateEntry',
      'projectDefaults',
      'schemaVersion',
      'sources',
    ])
    for (const forbidden of [
      'bitwarden-1',
      'Bitwarden work',
      'provider-detail-canary',
      'organization-detail-canary',
      'project-alpha',
      'secret-id-canary',
      'docker-command-output-canary',
      'docker build',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it.each([
    'RAPA\\cosborne',
    'cosborne@example.com',
  ])('saves a local secret with the domain account alias %s', async (alias) => {
    secureSecretsApiMock.createLocalSecret.mockResolvedValue(SECRET_SUMMARY)
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: alias },
    })
    fireEvent.change(getByLabelText(container, 'Private value'), {
      target: { value: 'private-canary' },
    })

    const saveButton = getByRole(
      container,
      'button',
      { name: 'Save local secret' },
    ) as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ displayAlias: alias }),
      )
    })
  })

  it('clears submitted local material immediately and leaves no secret value in the DOM', async () => {
    let resolveCreate: ((value: typeof SECRET_SUMMARY) => void) | undefined
    secureSecretsApiMock.createLocalSecret.mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve
    }))
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    const aliasInput = getByLabelText(container, 'Alias') as HTMLInputElement
    const noteInput = getByLabelText(container, 'Note (optional)') as HTMLTextAreaElement
    const materialInput = getByLabelText(container, 'Private value') as HTMLInputElement
    const rawSecret = 'dom-secret-canary-value'
    fireEvent.change(aliasInput, { target: { value: 'github/work' } })
    fireEvent.change(noteInput, {
      target: { value: 'Used by release automation.' },
    })
    fireEvent.change(materialInput, { target: { value: rawSecret } })

    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(materialInput.value).toBe('')
    })
    expect(container.textContent).not.toContain(rawSecret)
    expect(container.innerHTML).not.toContain(rawSecret)
    expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        note: 'Used by release automation.',
        material: rawSecret,
        scope: { kind: 'profile', profileId: 'project-alpha' },
      }),
    )

    resolveCreate?.(SECRET_SUMMARY)
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
      expect(noteInput.value).toBe('')
    })
  })

  it('clears a submitted Bitwarden token and offers no reveal control', async () => {
    let resolveConnect: ((value: unknown) => void) | undefined
    secureSecretsApiMock.connectBitwardenProvider.mockImplementation(() => new Promise((resolve) => {
      resolveConnect = resolve
    }))
    render()

    await waitFor(() => {
      expect(getByText(container, 'Connect Bitwarden Secrets Manager')).toBeTruthy()
    })
    const tokenInput = getByLabelText(
      container,
      'Machine account access token',
    ) as HTMLInputElement
    const rawToken = 'dom-bitwarden-token-canary'
    fireEvent.change(tokenInput, { target: { value: rawToken } })

    expect(queryByRole(container, 'button', { name: /reveal|show/i })).toBeNull()
    fireEvent.click(getByRole(container, 'button', { name: 'Connect' }))

    await waitFor(() => {
      expect(tokenInput.value).toBe('')
    })
    expect(container.textContent).not.toContain(rawToken)
    expect(container.innerHTML).not.toContain(rawToken)

    resolveConnect?.({
      providerId: 'bitwarden-1',
      kind: 'bitwarden_secrets_manager',
      displayName: 'Bitwarden Secrets Manager',
      enabled: true,
      status: 'available',
      lastVerifiedAt: null,
      lastStatusCode: null,
    })
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
    })
  })

  it('recovers unreadable local values one alias at a time and retests when done', async () => {
    let resolveUpdate: ((value: typeof SECRET_SUMMARY) => void) | undefined
    secureSecretsApiMock.testSecureSecretProvider
      .mockResolvedValueOnce({
        provider: LOCAL_PROVIDER,
        code: 'local_secret_decrypt_failed',
        affectedSecrets: [
          { secretId: 'secret-1', displayAlias: 'github/work' },
          { secretId: 'secret-2', displayAlias: 'database/staging' },
          { secretId: 'secret-3', displayAlias: 'service/retired' },
        ],
      })
    secureSecretsApiMock.updateSecureSecret.mockImplementation(() =>
      new Promise((resolve) => {
        resolveUpdate = resolve
      }))
    secureSecretsApiMock.deleteSecureSecret.mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render()

    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Test vault' })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Test vault' }))
    await waitFor(() => {
      expect(getByRole(container, 'button', {
        name: 'Re-enter values on this machine',
      })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', {
      name: 'Re-enter values on this machine',
    }))
    const firstValue = await waitFor(() =>
      getByLabelText(container, 'Private value for github/work') as HTMLInputElement)
    const rawValue = 'local-recovery-value-canary'
    fireEvent.change(firstValue, { target: { value: rawValue } })
    fireEvent.click(getByRole(container, 'button', { name: 'Save and continue' }))

    await waitFor(() => {
      expect(firstValue.value).toBe('')
      expect(secureSecretsApiMock.updateSecureSecret).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        { material: rawValue },
      )
    })
    expect(container.innerHTML).not.toContain(rawValue)

    resolveUpdate?.(SECRET_SUMMARY)
    await waitFor(() => {
      expect(getByLabelText(
        container,
        'Private value for database/staging',
      )).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Skip' }))
    await waitFor(() => {
      expect(getByLabelText(
        container,
        'Private value for service/retired',
      )).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Delete' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.deleteSecureSecret).toHaveBeenCalledWith(
        expect.anything(),
        'secret-3',
      )
      expect(secureSecretsApiMock.testSecureSecretProvider).toHaveBeenCalledTimes(1)
      expect(container.textContent).not.toContain('Re-enter values on this machine')
    })
    await waitFor(() => {
      expect(container.textContent).toContain(
        'Recovery paused. Skipped local values remain unavailable.',
      )
    })
  })

  it('retests the local vault after recovery completes without a skipped value', async () => {
    secureSecretsApiMock.testSecureSecretProvider
      .mockResolvedValueOnce({
        provider: LOCAL_PROVIDER,
        code: 'local_secret_decrypt_failed',
        affectedSecrets: [
          { secretId: 'secret-1', displayAlias: 'github/work' },
        ],
      })
      .mockResolvedValueOnce({
        provider: LOCAL_PROVIDER,
        code: 'ok',
        affectedSecrets: [],
      })
    secureSecretsApiMock.deleteSecureSecret.mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render()

    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Test vault' })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Test vault' }))
    await waitFor(() => {
      expect(getByRole(container, 'button', {
        name: 'Re-enter values on this machine',
      })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', {
      name: 'Re-enter values on this machine',
    }))
    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Delete' })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Delete' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.testSecureSecretProvider).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('Re-enter values on this machine')
    })
  })

  it('reconnects Bitwarden inline and clears the token before awaiting', async () => {
    let resolveReconnect: ((value: typeof BITWARDEN_PROVIDER) => void) | undefined
    const reconnectProvider = {
      ...BITWARDEN_PROVIDER,
      status: 'auth_required' as const,
      lastStatusCode: 'provider_auth_required' as const,
    }
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER, reconnectProvider],
      secrets: [],
      projectDefaults: [],
    })
    secureSecretsApiMock.reconnectBitwardenProvider.mockImplementation(() =>
      new Promise((resolve) => {
        resolveReconnect = resolve
      }))
    render()

    await waitFor(() => {
      expect(getByRole(container, 'button', { name: 'Reconnect' })).toBeTruthy()
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Reconnect' }))
    const token = await waitFor(() => getByLabelText(
      container,
      'New machine account access token',
    ) as HTMLInputElement)
    const rawToken = 'bitwarden-reconnect-token-canary'
    fireEvent.change(token, { target: { value: rawToken } })
    fireEvent.click(getByRole(container, 'button', { name: 'Save token' }))

    await waitFor(() => {
      expect(token.value).toBe('')
      expect(secureSecretsApiMock.reconnectBitwardenProvider).toHaveBeenCalledWith(
        expect.anything(),
        'bitwarden-1',
        rawToken,
      )
    })
    expect(container.innerHTML).not.toContain(rawToken)
    expect(container.textContent).toContain('Bitwarden work')

    resolveReconnect?.(BITWARDEN_PROVIDER)
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
    })
  })

  it('shows supported private storage as locked and disables material entry until unlock', async () => {
    secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(false)
    render()

    await waitFor(() => {
      expect(container.textContent).toContain('Private storage is locked')
      expect(container.textContent).toContain('Unlock private storage')
    })
    activateTab('Secrets')
    expect((getByLabelText(container, 'Private value') as HTMLInputElement).disabled).toBe(true)
    expect(
      (getByRole(container, 'button', { name: 'Save local secret' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('keeps the unavailable state for desktops without a private storage bridge', async () => {
    secureSecretsApiMock.isSecureMaterialEntryAvailable.mockReturnValue(false)
    secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(false)
    render()

    await waitFor(() => {
      expect(container.textContent).toContain('Secure operating-system storage is unavailable')
      expect(queryByRole(container, 'button', {
        name: 'Unlock private storage',
      })).toBeNull()
    })
  })

  it('imports a Bitwarden secret reference and clears the provider locator immediately', async () => {
    let resolveImport: ((value: typeof SECRET_SUMMARY) => void) | undefined
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER, BITWARDEN_PROVIDER],
      secrets: [],
    })
    secureSecretsApiMock.importBitwardenSecret.mockImplementation(() => new Promise((resolve) => {
      resolveImport = resolve
    }))
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    const locatorInput = getByLabelText(container, 'Bitwarden secret ID') as HTMLInputElement
    const aliasInput = getByLabelText(container, 'Forge alias') as HTMLInputElement
    fireEvent.click(
      container.querySelector('#bitwarden-secret-automatic-project-alpha')!,
    )
    fireEvent.change(locatorInput, { target: { value: 'provider-secret-uuid' } })
    fireEvent.change(aliasInput, { target: { value: 'database/production' } })
    fireEvent.click(getByRole(container, 'button', { name: 'Import reference' }))

    await waitFor(() => {
      expect(locatorInput.value).toBe('')
    })
    expect(secureSecretsApiMock.importBitwardenSecret).toHaveBeenCalledWith(
      expect.anything(),
      {
        providerId: 'bitwarden-1',
        sourceLocator: 'provider-secret-uuid',
        displayAlias: 'database/production',
        scope: { kind: 'profile', profileId: 'project-alpha' },
      },
    )

    resolveImport?.({ ...SECRET_SUMMARY, providerId: 'bitwarden-1' })
    await waitFor(() => {
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        { kind: 'projects', profileIds: ['project-alpha'] },
      )
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
    })
  })

  it('scopes new local secrets to the active project and can grant them automatically there', async () => {
    secureSecretsApiMock.createLocalSecret.mockResolvedValue(SECRET_SUMMARY)
    secureSecretsApiMock.updateSecureSecretAutomaticGrant.mockResolvedValue(SECRET_SUMMARY)
    render(makeClient(), 'project-beta')

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: 'github/work' },
    })
    fireEvent.change(getByLabelText(container, 'Private value'), {
      target: { value: 'private-canary' },
    })
    const automaticGrantCheckbox = getByRole(container, 'checkbox', {
      name: 'Automatically grant in Beta Project',
    })
    fireEvent.click(automaticGrantCheckbox)
    await waitFor(() => {
      expect(automaticGrantCheckbox.getAttribute('data-state')).toBe('checked')
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: { kind: 'profile', profileId: 'project-beta' },
        }),
      )
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        { kind: 'projects', profileIds: ['project-beta'] },
      )
    })
  })

  it('sets one atomic multi-project automatic grant policy for a new local secret', async () => {
    secureSecretsApiMock.createLocalSecret.mockResolvedValue(SECRET_SUMMARY)
    secureSecretsApiMock.updateSecureSecretAutomaticGrant.mockResolvedValue(SECRET_SUMMARY)
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    await chooseAvailability('local-secret-scope', 'Available in Beta Project')

    fireEvent.click(getByRole(container, 'checkbox', {
      name: 'Automatically grant in Alpha Project',
    }))
    fireEvent.click(getByRole(container, 'checkbox', {
      name: 'Automatically grant in Beta Project',
    }))
    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: 'github/work' },
    })
    fireEvent.change(getByLabelText(container, 'Private value'), {
      target: { value: 'private-canary' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: {
            kind: 'profiles',
            profileIds: ['project-alpha', 'project-beta'],
          },
        }),
      )
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledTimes(1)
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        {
          kind: 'projects',
          profileIds: ['project-alpha', 'project-beta'],
        },
      )
    })
  })

  it('offers every current and future project only to all-project secrets', async () => {
    secureSecretsApiMock.createLocalSecret.mockResolvedValue(SECRET_SUMMARY)
    secureSecretsApiMock.updateSecureSecretAutomaticGrant.mockResolvedValue(SECRET_SUMMARY)
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    expect(queryByRole(container, 'checkbox', {
      name: 'Every project, including future projects',
    })).toBeNull()
    expect(getByRole(container, 'checkbox', {
      name: 'Automatically grant in Alpha Project',
    })).toBeTruthy()
    expect(queryByRole(container, 'checkbox', {
      name: 'Automatically grant in Beta Project',
    })).toBeNull()

    await chooseAvailability('local-secret-scope', 'Available in all projects')
    const everyProject = getByRole(container, 'checkbox', {
      name: 'Every project, including future projects',
    })
    fireEvent.click(everyProject)
    expect(container.textContent).toContain(
      'Includes current projects and projects created later.',
    )
    await waitFor(() => {
      expect((getByRole(container, 'checkbox', {
        name: 'Automatically grant in Alpha Project',
      }) as HTMLButtonElement).disabled).toBe(true)
    })

    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: 'github/work' },
    })
    fireEvent.change(getByLabelText(container, 'Private value'), {
      target: { value: 'private-canary' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        { kind: 'all_projects' },
      )
    })
  })

  it('prevents enabling a seventeenth automatic secret in one project', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [],
      projectDefaults: Array.from(
        { length: SECURE_SECRET_MAX_PROJECT_DEFAULTS },
        (_, index) => ({
          profileId: 'project-alpha',
          secretId: `existing-secret-${index + 1}`,
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        }),
      ),
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    const automaticGrantCheckbox = getByRole(container, 'checkbox', {
      name: 'Automatically grant in Alpha Project',
    }) as HTMLButtonElement
    expect(automaticGrantCheckbox.disabled).toBe(true)
    expect(container.textContent).toContain(
      `A project with ${SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic grants cannot receive another until one is removed.`,
    )
  })

  it('shows project names for scope and independent automatic grants', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [{
        ...SECRET_SUMMARY,
        scope: { kind: 'instance' as const },
      }],
      projectDefaults: [
        {
          profileId: 'project-alpha',
          secretId: 'secret-1',
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        },
        {
          profileId: 'project-beta',
          secretId: 'secret-1',
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        },
      ],
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')

    expect(container.textContent).toContain('All projects')
    expect(container.textContent).toContain('Automatically granted in Alpha Project')
    expect(container.textContent).toContain('Automatically granted in Beta Project')
  })

  it('edits an existing selected-project scope without collapsing it', async () => {
    const selectedProjectsSecret = {
      ...SECRET_SUMMARY,
      scope: {
        kind: 'profiles' as const,
        profileIds: ['project-alpha', 'project-beta'],
      },
    }
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [selectedProjectsSecret],
      projectDefaults: [],
    })
    secureSecretsApiMock.updateSecureSecret.mockResolvedValue(
      selectedProjectsSecret,
    )
    secureSecretsApiMock.updateSecureSecretAutomaticGrant.mockResolvedValue(
      selectedProjectsSecret,
    )
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    expect(container.textContent).toContain('2 projects')
    expect(container.textContent).toContain('Used by release automation.')

    fireEvent.click(getByRole(container, 'button', { name: 'Edit' }))
    const editNote = await waitFor(() => {
      const textarea = container.querySelector(
        '#edit-note-secret-1',
      ) as HTMLTextAreaElement | null
      expect(textarea).toBeTruthy()
      return textarea!
    })
    expect(editNote.value).toBe('Used by release automation.')
    fireEvent.change(editNote, {
      target: { value: 'Used for deploys and rollbacks.' },
    })
    let scopeTrigger: Element | null = null
    await waitFor(() => {
      scopeTrigger = container.querySelector('#edit-secret-1-scope')
      expect(scopeTrigger).toBeTruthy()
    })
    flushSync(() => {
      fireEvent.click(scopeTrigger!)
    })
    let alphaScopeCheckbox: HTMLElement | null = null
    let betaScopeCheckbox: HTMLElement | null = null
    await waitFor(() => {
      alphaScopeCheckbox = getByRole(document.body, 'checkbox', {
        name: 'Available in Alpha Project',
      })
      betaScopeCheckbox = getByRole(document.body, 'checkbox', {
        name: 'Available in Beta Project',
      })
    })
    expect(
      alphaScopeCheckbox!.getAttribute('data-state'),
    ).toBe('checked')
    expect(
      betaScopeCheckbox!.getAttribute('data-state'),
    ).toBe('checked')
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    fireEvent.click(getByRole(container, 'button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.updateSecureSecret).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        expect.objectContaining({
          note: 'Used for deploys and rollbacks.',
          scope: {
            kind: 'profiles',
            profileIds: ['project-alpha', 'project-beta'],
          },
        }),
      )
    })
  })

  it('prevents an alias collision in the same project with clear safe copy', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [{
        ...SECRET_SUMMARY,
        scope: { kind: 'profile' as const, profileId: 'project-alpha' },
      }],
      projectDefaults: [],
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    fireEvent.change(getByLabelText(container, 'Alias'), {
      target: { value: 'github/work' },
    })
    fireEvent.change(getByLabelText(container, 'Private value'), {
      target: { value: 'private-collision-canary' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(container.textContent).toContain(
        'A secret with this alias already exists in that scope.',
      )
    })
    expect(secureSecretsApiMock.createLocalSecret).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('private-collision-canary')
  })

  it('allows an existing all-project secret to move into one selected project', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER],
      secrets: [{
        ...SECRET_SUMMARY,
        scope: { kind: 'instance' as const },
      }],
      projectDefaults: [
        {
          profileId: 'project-alpha',
          secretId: 'secret-1',
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        },
        {
          profileId: 'project-beta',
          secretId: 'secret-1',
          createdAt: '2026-07-24T12:00:00.000Z',
          updatedAt: '2026-07-24T12:00:00.000Z',
        },
      ],
    })
    secureSecretsApiMock.updateSecureSecret.mockResolvedValue({
      ...SECRET_SUMMARY,
      scope: { kind: 'profile', profileId: 'project-alpha' },
    })
    secureSecretsApiMock.updateSecureSecretAutomaticGrant.mockResolvedValue({
      ...SECRET_SUMMARY,
      scope: { kind: 'profile', profileId: 'project-alpha' },
      automaticGrantPolicy: {
        kind: 'projects',
        profileIds: ['project-alpha'],
      },
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    fireEvent.click(getByRole(container, 'button', { name: 'Edit' }))
    await chooseAvailability(
      'edit-secret-1-scope',
      'Available in Alpha Project',
    )
    fireEvent.click(getByRole(container, 'button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.updateSecureSecret).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        expect.objectContaining({
          scope: { kind: 'profile', profileId: 'project-alpha' },
        }),
      )
      expect(secureSecretsApiMock.updateSecureSecretAutomaticGrant).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        { kind: 'projects', profileIds: ['project-alpha'] },
      )
    })
    expect(
      secureSecretsApiMock.updateSecureSecret.mock.invocationCallOrder[0],
    ).toBeLessThan(
      secureSecretsApiMock.updateSecureSecretAutomaticGrant.mock.invocationCallOrder[0]!,
    )
  })

  it('sends all-project scope when selected for a Bitwarden reference', async () => {
    secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
      providers: [LOCAL_PROVIDER, BITWARDEN_PROVIDER],
      secrets: [],
      projectDefaults: [],
    })
    secureSecretsApiMock.importBitwardenSecret.mockResolvedValue({
      ...SECRET_SUMMARY,
      providerId: 'bitwarden-1',
      scope: { kind: 'instance' },
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    await chooseAvailability(
      'bitwarden-secret-scope',
      'Available in all projects',
    )
    fireEvent.change(getByLabelText(container, 'Bitwarden secret ID'), {
      target: { value: '12345678-1234-1234-1234-123456789012' },
    })
    fireEvent.change(getByLabelText(container, 'Forge alias'), {
      target: { value: 'database/production' },
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Import reference' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.importBitwardenSecret).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: { kind: 'instance' } }),
      )
    })
  })
})

function activateTab(name: string): void {
  const tab = getByRole(container, 'tab', { name })
  flushSync(() => {
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
    fireEvent.click(tab)
  })
}

async function chooseAvailability(id: string, option: string): Promise<void> {
  let trigger: Element | null = null
  await waitFor(() => {
    trigger = container.querySelector(`#${id}`)
    expect(trigger).toBeTruthy()
  })
  flushSync(() => {
    fireEvent.click(trigger!)
  })
  let checkbox: HTMLElement | null = null
  await waitFor(() => {
    checkbox = getByRole(document.body, 'checkbox', { name: option })
    expect(checkbox).toBeTruthy()
  })
  flushSync(() => {
    fireEvent.click(checkbox!)
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
  })
}

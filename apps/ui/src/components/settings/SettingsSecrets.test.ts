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

const secureSecretsApiMock = vi.hoisted(() => ({
  fetchSecureSecretsCatalog: vi.fn(),
  createLocalSecret: vi.fn(),
  updateSecureSecret: vi.fn(),
  deleteSecureSecret: vi.fn(),
  connectBitwardenProvider: vi.fn(),
  importBitwardenSecret: vi.fn(),
  testSecureSecretProvider: vi.fn(),
  disconnectSecureSecretProvider: vi.fn(),
  isSecureMaterialEntryAvailable: vi.fn(() => true),
  checkSecureMaterialEntryAvailability: vi.fn(async () => true),
}))

vi.mock('@/lib/secure-secrets-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/secure-secrets-api')>()
  return {
    ...original,
    fetchSecureSecretsCatalog: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSecretsCatalog(...args),
    createLocalSecret: (...args: unknown[]) =>
      secureSecretsApiMock.createLocalSecret(...args),
    updateSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecret(...args),
    deleteSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.deleteSecureSecret(...args),
    connectBitwardenProvider: (...args: unknown[]) =>
      secureSecretsApiMock.connectBitwardenProvider(...args),
    importBitwardenSecret: (...args: unknown[]) =>
      secureSecretsApiMock.importBitwardenSecret(...args),
    testSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.testSecureSecretProvider(...args),
    disconnectSecureSecretProvider: (...args: unknown[]) =>
      secureSecretsApiMock.disconnectSecureSecretProvider(...args),
    isSecureMaterialEntryAvailable: () =>
      secureSecretsApiMock.isSecureMaterialEntryAvailable(),
    checkSecureMaterialEntryAvailability: () =>
      secureSecretsApiMock.checkSecureMaterialEntryAvailability(),
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

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(true)
  secureSecretsApiMock.fetchSecureSecretsCatalog.mockResolvedValue({
    providers: [LOCAL_PROVIDER],
    secrets: [],
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
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

function render(client = makeClient()): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsSecrets, { apiClient: client }))
  })
}

describe('SettingsSecrets', () => {
  it('never loads secure settings for a remote origin', () => {
    render(makeClient('collab'))

    expect(container.textContent).toContain('Local Builder only')
    expect(container.textContent).toContain('disabled for remote origins')
    expect(secureSecretsApiMock.fetchSecureSecretsCatalog).not.toHaveBeenCalled()
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
    expect(container.textContent).toContain('no task receives access until you grant it')

    activateTab('Advanced delivery')
    expect(container.textContent).toContain('Delivery never grants task access by itself')
    expect(container.textContent).toContain('generated environment delivery')
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
    const materialInput = getByLabelText(container, 'Private value') as HTMLInputElement
    const rawSecret = 'dom-secret-canary-value'
    fireEvent.change(aliasInput, { target: { value: 'github/work' } })
    fireEvent.change(materialInput, { target: { value: rawSecret } })

    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(materialInput.value).toBe('')
    })
    expect(container.textContent).not.toContain(rawSecret)
    expect(container.innerHTML).not.toContain(rawSecret)
    expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ material: rawSecret }),
    )

    resolveCreate?.(SECRET_SUMMARY)
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
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

  it('disables local material entry when desktop secure storage is unavailable', async () => {
    secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(false)
    render()

    await waitFor(() => {
      expect(container.textContent).toContain('Secure operating-system storage is unavailable')
    })
    activateTab('Secrets')
    expect((getByLabelText(container, 'Private value') as HTMLInputElement).disabled).toBe(true)
    expect(
      (getByRole(container, 'button', { name: 'Save local secret' }) as HTMLButtonElement).disabled,
    ).toBe(true)
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
      },
    )

    resolveImport?.({ ...SECRET_SUMMARY, providerId: 'bitwarden-1' })
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
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

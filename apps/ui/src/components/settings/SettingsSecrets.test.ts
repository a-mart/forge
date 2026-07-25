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
  createLocalSecret: vi.fn(),
  updateSecureSecret: vi.fn(),
  updateSecureSecretProjectDefault: vi.fn(),
  deleteSecureSecret: vi.fn(),
  connectBitwardenProvider: vi.fn(),
  reconnectBitwardenProvider: vi.fn(),
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
    fetchSecureSessionReadiness: (...args: unknown[]) =>
      secureSecretsApiMock.fetchSecureSessionReadiness(...args),
    createLocalSecret: (...args: unknown[]) =>
      secureSecretsApiMock.createLocalSecret(...args),
    updateSecureSecret: (...args: unknown[]) =>
      secureSecretsApiMock.updateSecureSecret(...args),
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
  secureSecretsApiMock.checkSecureMaterialEntryAvailability.mockResolvedValue(true)
  secureSecretsApiMock.fetchSecureSessionReadiness.mockResolvedValue({
    available: true,
    code: 'available',
  })
  secureSecretsApiMock.testSecureSecretProvider.mockReset()
  secureSecretsApiMock.testSecureSecretProvider.mockResolvedValue({
    provider: LOCAL_PROVIDER,
    code: 'ok',
    affectedSecrets: [],
  })
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
      'Access still requires a grant unless you explicitly enable a project default',
    )

    activateTab('Advanced delivery')
    expect(container.textContent).toContain('Delivery never grants task access by itself')
    expect(container.textContent).toContain('generated environment delivery')
  })

  it('shows fixed readiness actions and copies only bounded safe diagnostics', async () => {
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
    fireEvent.click(getByRole(container, 'button', {
      name: 'Copy build command',
    }))
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(
        'docker build --tag forge-secure-runner:node22-v4 --file apps/backend/src/swarm/secure-sessions/execution/Dockerfile.secure-runner apps/backend/src/swarm/secure-sessions/execution',
      )
    })
    fireEvent.click(getByRole(container, 'button', {
      name: 'Copy safe diagnostics',
    }))

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(2)
    })
    const serialized = String(clipboardWriteText.mock.calls[1]?.[0])
    const diagnostics = JSON.parse(serialized)
    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      execution: { code: 'image_unavailable' },
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
      expect.objectContaining({
        material: rawSecret,
        scope: { kind: 'profile', profileId: 'project-alpha' },
      }),
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
        scope: { kind: 'profile', profileId: 'project-alpha' },
      },
    )

    resolveImport?.({ ...SECRET_SUMMARY, providerId: 'bitwarden-1' })
    await waitFor(() => {
      expect(secureSecretsApiMock.fetchSecureSecretsCatalog).toHaveBeenCalledTimes(2)
    })
  })

  it('defaults new local secrets to the active project and can make them project defaults', async () => {
    secureSecretsApiMock.createLocalSecret.mockResolvedValue(SECRET_SUMMARY)
    secureSecretsApiMock.updateSecureSecretProjectDefault.mockResolvedValue({
      profileId: 'project-beta',
      secretId: 'secret-1',
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
    })
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
    const projectDefaultSwitch = getByRole(container, 'switch', {
      name: 'Automatically available in this project',
    })
    fireEvent.click(projectDefaultSwitch)
    await waitFor(() => {
      expect(projectDefaultSwitch.getAttribute('aria-checked')).toBe('true')
    })
    fireEvent.click(getByRole(container, 'button', { name: 'Save local secret' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.createLocalSecret).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: { kind: 'profile', profileId: 'project-beta' },
        }),
      )
      expect(secureSecretsApiMock.updateSecureSecretProjectDefault).toHaveBeenCalledWith(
        expect.anything(),
        'project-beta',
        'secret-1',
        true,
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

    const projectDefaultSwitch = getByRole(container, 'switch', {
      name: 'Automatically available in this project',
    }) as HTMLButtonElement
    expect(projectDefaultSwitch.disabled).toBe(true)
    expect(container.textContent).toContain(
      `This project already has ${SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic secrets. Disable one before enabling another.`,
    )
  })

  it('shows project names for scope and independent project defaults', async () => {
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
    expect(container.textContent).toContain('Default in Alpha Project')
    expect(container.textContent).toContain('Default in Beta Project')
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
    secureSecretsApiMock.updateSecureSecretProjectDefault.mockResolvedValue(null)
    secureSecretsApiMock.updateSecureSecret.mockResolvedValue({
      ...SECRET_SUMMARY,
      scope: { kind: 'profile', profileId: 'project-alpha' },
    })
    render()

    await waitFor(() => {
      expect(getByText(container, 'Private sources')).toBeTruthy()
    })
    activateTab('Secrets')
    fireEvent.click(getByRole(container, 'button', { name: 'Edit' }))
    await chooseSelect('edit-secret-1-scope', 'Only this project')
    fireEvent.click(getByRole(container, 'button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(secureSecretsApiMock.updateSecureSecret).toHaveBeenCalledWith(
        expect.anything(),
        'secret-1',
        expect.objectContaining({
          scope: { kind: 'profile', profileId: 'project-alpha' },
        }),
      )
      expect(secureSecretsApiMock.updateSecureSecretProjectDefault).toHaveBeenCalledWith(
        expect.anything(),
        'project-beta',
        'secret-1',
        false,
      )
    })
    expect(
      secureSecretsApiMock.updateSecureSecretProjectDefault.mock.invocationCallOrder[0],
    ).toBeLessThan(secureSecretsApiMock.updateSecureSecret.mock.invocationCallOrder[0]!)
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
    await chooseSelect('bitwarden-secret-scope', 'All projects')
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

async function chooseSelect(id: string, option: string): Promise<void> {
  let trigger: Element | null = null
  await waitFor(() => {
    trigger = container.querySelector(`#${id}`)
    expect(trigger).toBeTruthy()
  })
  flushSync(() => {
    fireEvent.keyDown(trigger!, { key: 'Enter', code: 'Enter' })
  })
  await waitFor(() => {
    expect(getByRole(document.body, 'option', { name: option })).toBeTruthy()
  })
  flushSync(() => {
    fireEvent.click(getByRole(document.body, 'option', { name: option }))
  })
  await waitFor(() => {
    expect(container.getAttribute('aria-hidden')).not.toBe('true')
  })
}

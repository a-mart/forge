/** @vitest-environment jsdom */
import { fireEvent, getByLabelText, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenRouterRouting, type OpenRouterEndpointsResponse, type OpenRouterRoutingConfig } from '@forge/protocol'
import { createSettingsApiClient, type SettingsApiClient } from './settings-api-client'
import { createCollabSettingsTarget } from './settings-target'
import { fetchOpenRouterEndpoints, fetchOpenRouterRouting, saveOpenRouterRouting } from './openrouter-routing-api'
import { OpenRouterRoutingDialog } from './OpenRouterRoutingDialog'
import { SettingsOpenRouter } from './SettingsOpenRouter'

vi.mock('./OpenRouterBrowseDialog', () => ({ OpenRouterBrowseDialog: () => null }))
let root: Root
let container: HTMLDivElement
let defaults: OpenRouterRoutingConfig
let routing: OpenRouterRoutingConfig
let revision: number
let client: SettingsApiClient
let offline: boolean
let conflict: boolean
const modelId = 'publisher/model'
const endpoints: OpenRouterEndpointsResponse = { modelId, status: 'fresh', zdrStatus: 'fresh', endpoints: [
  { tag: 'azure/east', name: 'Azure East', providerName: 'Azure', supportedParameters: ['tools'], zdr: 'eligible', pricing: { prompt: 2, completion: 4 } },
  { tag: 'openai', name: 'OpenAI', providerName: 'OpenAI', supportedParameters: [], zdr: 'not-listed' },
] }
const response = (model: boolean) => ({ revision: String(revision), defaults, ...(model ? { modelId, routing } : {}), effective: resolveOpenRouterRouting(defaults, model ? routing : {}) })
const close = vi.fn()
const saved = vi.fn()

beforeEach(() => {
  defaults = {}; routing = {}; revision = 1; offline = false; conflict = false
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  client = {
    target: createCollabSettingsTarget('wss://remote.example/ws', 'https://remote.example'),
    endpoint: (path) => `https://remote.example${path}`,
    fetchJson: vi.fn(async (path: string) => {
      if (path.includes('/endpoints/')) { if (offline) throw new Error('offline'); return endpoints }
      if (path === '/api/settings/openrouter/models') return { isConfigured: true, models: [{ modelId, displayName: 'Test model', contextWindow: 1000, maxOutputTokens: 100, supportsReasoning: false, supportedReasoningLevels: [], inputModes: ['text'], addedAt: '', supportsTools: true, routing }] }
      return response(path.includes('/routing/models/'))
    }) as SettingsApiClient['fetchJson'],
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method !== 'PUT') return new Response(JSON.stringify(await client.fetchJson(path)))
      if (conflict) return new Response('{}', { status: 409 })
      const body = JSON.parse(String(init?.body))
      expect(body.revision).toBe(String(revision))
      if (path.includes('/routing/models/')) routing = body.routing
      else defaults = body.routing
      revision++
      return new Response(JSON.stringify(response(path.includes('/routing/models/'))))
    }),
    readApiError: async () => 'Request failed',
  }
})
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals() })
const body = () => document.body
async function renderDialog(model: string | undefined = modelId, event = 0) {
  flushSync(() => root.render(createElement(OpenRouterRoutingDialog, { clientOrWsUrl: client, modelId: model, modelConfigChangeKey: event, onClose: close, onSaved: saved })))
  await waitFor(() => expect(getByRole(body(), 'button', { name: 'Save routing' })).toBeTruthy())
}
function change(label: string, value: string) { flushSync(() => fireEvent.change(getByLabelText(body(), label), { target: { value } })) }
function click(name: string) { flushSync(() => fireEvent.click(getByRole(body(), 'button', { name }))) }
const preview = () => getByRole(body(), 'region', { name: 'Effective routing preview' }).textContent
async function save() { click('Save routing'); await waitFor(() => expect(saved).toHaveBeenCalled()) }

describe('OpenRouter routing editor', () => {
  it('saves shared defaults, reopens persisted values, and resets without paid calls', async () => {
    await renderDialog('')
    change('Require zero data retention', 'true'); change('Provider data collection', 'deny')
    expect(preview()).toContain('"zdr": true')
    await save()
    expect(defaults).toEqual({ zdr: true, data_collection: 'deny' })
    flushSync(() => root.render(null)); await renderDialog('')
    expect(getByLabelText(body(), 'Require zero data retention')).toHaveProperty('value', 'true')
    click('Reset all defaults'); expect(preview()).not.toContain('"zdr"')
    saved.mockClear(); await save(); expect(defaults).toEqual({})
    expect(client.fetch).toHaveBeenCalledTimes(2)
  })

  it('distinguishes field inheritance, explicit clear, replacement, and privacy floors', async () => {
    defaults = { zdr: true, data_collection: 'deny', only: ['azure'], max_price: { prompt: 1, completion: 2 } }
    routing = { zdr: false, data_collection: null }
    await renderDialog()
    expect(preview()).toContain('"zdr": true'); expect(preview()).toContain('"data_collection": "deny"')
    const zdr = getByLabelText(body(), 'Require zero data retention') as HTMLSelectElement
    expect(zdr.querySelector('option[value="false"]')).toHaveProperty('disabled', true)
    expect(zdr.querySelector('option[value="clear"]')).toHaveProperty('disabled', true)
    change('Allowed providers only mode', 'clear'); expect(preview()).not.toContain('"only"')
    change('Price ceilings mode', 'custom'); change('Input price ceiling', '3'); change('Output price ceiling', '')
    expect(preview()).toContain('"prompt": 3'); expect(preview()).not.toContain('"completion"')
    await save(); expect(routing.only).toBeNull(); expect(routing.max_price).toEqual({ prompt: 3 })
    click('Reset all to inherit'); expect(preview()).toContain('"azure"')
  })

  it('reopens a saved model clear and resets it to inherit the shared allowlist', async () => {
    defaults = { only: ['azure'] }
    await renderDialog()
    change('Allowed providers only mode', 'clear')
    await save()
    flushSync(() => root.render(null)); await renderDialog()
    expect(getByLabelText(body(), 'Allowed providers only mode')).toHaveProperty('value', 'clear')
    expect(preview()).not.toContain('"only"')
    click('Reset all to inherit'); saved.mockClear(); await save()
    expect(routing).toEqual({})
    flushSync(() => root.render(null)); await renderDialog()
    expect(preview()).toContain('"azure"')
  })

  it('requires explicit clearing of inherited preferred order before sort, and vice versa', async () => {
    defaults = { order: ['azure'] }; await renderDialog()
    change('Routing strategy', 'latency')
    expect(getByText(body(), 'OpenRouter order and sort are mutually exclusive')).toBeTruthy()
    expect(getByRole(body(), 'button', { name: 'Save routing' })).toHaveProperty('disabled', true)
    change('Preferred providers mode', 'clear'); await save()
    expect(routing).toEqual({ order: null, sort: 'latency' })
    flushSync(() => root.render(null)); defaults = { sort: 'price' }; routing = {}; await renderDialog()
    change('Preferred providers mode', 'custom'); click('Add openai to Preferred providers')
    expect(getByRole(body(), 'button', { name: 'Save routing' })).toHaveProperty('disabled', true)
    change('Routing strategy', 'clear'); expect(preview()).toContain('"openai"')
  })

  it('searches real endpoint slugs, orders accessibly, and validates allow/exclude conflicts', async () => {
    await renderDialog(); change('Preferred providers mode', 'custom')
    change('Search Preferred providers', 'azure'); expect(queryByText(body(), 'OpenAI · openai')).toBeNull()
    click('Add azure/east to Preferred providers'); change('Search Preferred providers', ''); click('Add openai to Preferred providers')
    click('Move openai up'); expect(preview()!.indexOf('openai')).toBeLessThan(preview()!.indexOf('azure/east'))
    change('Allowed providers only mode', 'custom'); click('Add openai to Allowed providers only')
    change('Excluded providers mode', 'custom'); click('Add openai to Excluded providers')
    expect(getByText(body(), 'OpenRouter allowed providers conflict with excluded providers')).toBeTruthy()
    change('Excluded providers mode', 'clear'); await save(); expect(routing.order).toEqual(['openai', 'azure/east'])
  })

  it('retains unknown saved slugs offline and permits manual entry without inventing ZDR badges', async () => {
    offline = true; routing = { only: ['unknown/saved'] }; await renderDialog()
    expect(getByText(body(), 'unknown/saved')).toBeTruthy()
    expect(getByText(body(), 'Unverified selection (retained)')).toBeTruthy()
    change('Manual slug for Allowed providers only', 'manual/new'); click('Add slug')
    await save(); expect(routing.only).toEqual(['unknown/saved', 'manual/new'])
    expect(body().textContent).not.toContain('ZDR advisory: eligible')
  })

  it('marks cached endpoint metadata stale on refresh failure without losing selections', async () => {
    routing = { only: ['azure/east'] }; await renderDialog()
    expect(getByText(body(), /ZDR advisory: eligible/)).toBeTruthy()
    offline = true; click('Refresh endpoints')
    await waitFor(() => expect(getByText(body(), /Endpoint discovery unavailable. Selections remain/)).toBeTruthy())
    expect(queryByText(body(), /ZDR advisory: eligible/)).toBeNull()
    expect(getByText(body(), 'azure/east')).toBeTruthy()
  })

  it('validates advanced prices and saves all advanced controls and quantization filters', async () => {
    await renderDialog(); change('Price ceilings mode', 'custom'); change('Input price ceiling', '-1')
    expect(getByRole(body(), 'button', { name: 'Save routing' })).toHaveProperty('disabled', true)
    change('Input price ceiling', '0'); change('Output price ceiling', '4.5')
    change('Allowed quantizations mode', 'custom')
    flushSync(() => fireEvent.click(getByLabelText(body(), 'fp8')))
    change('Require parameter support', 'true'); change('Provider fallback', 'false')
    await save(); expect(routing).toEqual({ max_price: { prompt: 0, completion: 4.5 }, quantizations: ['fp8'], require_parameters: true, allow_fallbacks: false })
  })

  it('preserves drafts on 409, disables resave, and explicitly reloads before review', async () => {
    await renderDialog(); change('Require zero data retention', 'true'); conflict = true; click('Save routing')
    await waitFor(() => expect(getByText(body(), /Routing changed elsewhere/)).toBeTruthy())
    expect(getByLabelText(body(), 'Require zero data retention')).toHaveProperty('value', 'true')
    expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
    expect(getByRole(body(), 'button', { name: 'Save routing' })).toHaveProperty('disabled', true)
    defaults = { data_collection: 'deny' }; conflict = false; click('Reload settings')
    await waitFor(() => expect(getByLabelText(body(), 'Require zero data retention')).toHaveProperty('value', 'inherit'))
    expect(preview()).toContain('"data_collection": "deny"')
  })

  it('live model_config_changed invalidates an open draft rather than overwriting it', async () => {
    await renderDialog(); change('Provider fallback', 'false'); defaults = { zdr: true }
    await renderDialog(modelId, 1)
    expect(getByLabelText(body(), 'Provider fallback')).toHaveProperty('value', 'false')
    expect(getByRole(body(), 'button', { name: 'Save routing' })).toHaveProperty('disabled', true)
    click('Reload settings')
    await waitFor(() => expect(preview()).toContain('"zdr": true'))
  })
})

describe('Settings OpenRouter refresh and scope', () => {
  const renderSettings = (apiClient = client, key = 0) => flushSync(() => root.render(createElement(SettingsOpenRouter, { wsUrl: undefined, apiClient, modelConfigChangeKey: key })))
  it('loads effective card summary on bootstrap and refreshes on model_config_changed', async () => {
    defaults = { zdr: true }; renderSettings()
    await waitFor(() => expect(getByRole(body(), 'button', { name: 'Configure routing' })).toBeTruthy())
    expect(getByLabelText(body(), 'Enable Test model for manager agents').getAttribute('data-state')).toBe('unchecked')
    expect(body().textContent).toContain('ZDR required')
    defaults = { data_collection: 'deny' }; renderSettings(client, 1)
    await waitFor(() => expect(body().textContent).toContain('No provider collection'))
    expect(body().textContent).not.toContain('ZDR required')
  })

  it('unmounts an old-origin editor and discards delayed old-origin settings responses', async () => {
    renderSettings(); await waitFor(() => expect(getByRole(body(), 'button', { name: 'Configure routing' })).toBeTruthy())
    let release!: (value: unknown) => void
    vi.mocked(client.fetchJson).mockImplementation(() => new Promise((resolve) => { release = resolve }) as never)
    click('OpenRouter defaults')
    const other = { ...client, endpoint: (path: string) => `https://other.example${path}`, fetch: vi.fn(async () => new Response(JSON.stringify({ isConfigured: true, models: [] }))), fetchJson: vi.fn(async () => ({ defaults: {}, revision: '1', effective: {} })) as SettingsApiClient['fetchJson'] }
    renderSettings(other)
    release({ defaults: { zdr: true }, revision: '1', effective: { zdr: true } })
    await waitFor(() => expect(getByText(body(), 'No models added yet')).toBeTruthy())
    expect(queryByText(body(), 'Save routing')).toBeNull()
    expect(body().textContent).not.toContain('ZDR required')
    expect(vi.mocked(client.fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })
})

it('routes API requests and encoded exact IDs through the remote SettingsApiClient with credentials', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ revision: '1', defaults: {}, effective: {}, endpoints: [] })))
  vi.stubGlobal('fetch', fetch)
  const remote = createSettingsApiClient(createCollabSettingsTarget('wss://remote.example/ws', 'https://remote.example'))
  await fetchOpenRouterRouting(remote, modelId)
  await saveOpenRouterRouting(remote, modelId, '1', { only: null })
  await fetchOpenRouterEndpoints(remote, modelId, true)
  expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
    'https://remote.example/api/settings/openrouter/routing/models/publisher%2Fmodel',
    'https://remote.example/api/settings/openrouter/routing/models/publisher%2Fmodel',
    'https://remote.example/api/settings/openrouter/endpoints/publisher%2Fmodel?refresh=true',
  ])
  for (const call of fetch.mock.calls) expect((call as unknown[])[1]).toMatchObject({ credentials: 'include' })
})

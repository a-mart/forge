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
  Element.prototype.scrollIntoView = vi.fn()
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
  await waitFor(() => expect(getByRole(body(), 'switch', { name: 'Zero data retention' })).toBeTruthy())
}
function change(label: string, value: string) { flushSync(() => fireEvent.change(getByLabelText(body(), label), { target: { value } })) }
function click(name: string) { flushSync(() => fireEvent.click(getByRole(body(), 'button', { name }))) }
function toggle(name: string) { flushSync(() => fireEvent.click(getByRole(body(), 'switch', { name }))) }
function expand(title: string) {
  const summary = [...body().querySelectorAll('summary')].find((item) => item.textContent?.startsWith(title))!
  if (!summary.parentElement?.hasAttribute('open')) flushSync(() => fireEvent.click(summary))
}
function fieldAction(label: string, action: 'reset' | 'clear' | 'custom' = 'clear') {
  const trigger = getByRole(body(), 'button', { name: new RegExp(`^${label} source:`) })
  flushSync(() => fireEvent.keyDown(trigger, { key: 'Enter' }))
  flushSync(() => fireEvent.click(getByRole(body(), 'menuitem', { name: action === 'clear' ? 'Clear · no additional restriction' : action === 'custom' ? 'Customize' : /Use .* default/ })))
}
function strategy(name: string) {
  expand('Advanced routing')
  flushSync(() => fireEvent.keyDown(getByRole(body(), 'combobox', { name: 'Routing strategy' }), { key: 'ArrowDown' }))
  flushSync(() => fireEvent.click(getByRole(body(), 'option', { name })))
}
const preview = () => getByRole(body(), 'region', { name: 'Effective routing preview' }).textContent
async function save() { click('Save changes'); await waitFor(() => expect(saved).toHaveBeenCalled()) }

describe('OpenRouter routing editor', () => {
  it('opens compactly with collapsed help and advanced controls; saves defaults and reopens', async () => {
    await renderDialog('')
    expect([...body().querySelectorAll('details')].every((item) => !item.open)).toBe(true)
    expect(body().querySelector('pre')).toBeNull()
    toggle('Zero data retention'); toggle('Block data collection')
    expect(preview()).toContain('ZDR required')
    await save(); expect(defaults).toEqual({ zdr: true, data_collection: 'deny' })
    flushSync(() => root.render(null)); await renderDialog('')
    expect(getByRole(body(), 'switch', { name: 'Zero data retention' }).getAttribute('aria-checked')).toBe('true')
    expand('Advanced routing'); click('Reset all defaults'); saved.mockClear(); await save()
    expect(defaults).toEqual({}); expect(client.fetch).toHaveBeenCalledTimes(2)
  })

  it('shows enforced privacy floors without mutating saved false or clear overrides', async () => {
    defaults = { zdr: true, data_collection: 'deny', only: ['azure'], max_price: { prompt: 1, completion: 2 } }
    routing = { zdr: false, data_collection: null }
    await renderDialog()
    for (const name of ['Zero data retention', 'Block data collection']) {
      expect(getByRole(body(), 'switch', { name })).toHaveProperty('disabled', true)
      expect(getByRole(body(), 'switch', { name }).getAttribute('aria-checked')).toBe('true')
      expect(getByRole(body(), 'button', { name: `${name} source: Required` })).toBeTruthy()
    }
    const trigger = getByRole(body(), 'button', { name: 'Zero data retention source: Required' })
    flushSync(() => fireEvent.keyDown(trigger, { key: 'Enter' }))
    expect(getByRole(body(), 'menuitem', { name: 'Clear · no additional restriction' }).getAttribute('data-disabled')).not.toBeNull()
    flushSync(() => fireEvent.keyDown(getByRole(body(), 'menu'), { key: 'Escape' }))
    click('Automatic'); expand('Advanced routing'); change('Input price ceiling', '3'); change('Output price ceiling', '')
    await save(); expect(routing).toEqual({ zdr: false, data_collection: null, only: null, order: null, max_price: { prompt: 3 } })
  })

  it('explicit Automatic clears inherited lists; per-field reset restores each independently', async () => {
    defaults = { only: ['azure'], order: ['azure'], sort: null }
    await renderDialog(); click('Automatic'); await save()
    expect(routing).toEqual({ only: null, order: null })
    flushSync(() => root.render(null)); await renderDialog()
    expect(getByRole(body(), 'button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(body(), 'button', { name: 'Allowed providers only source: Cleared' })).toBeTruthy()
    fieldAction('Allowed providers only', 'reset')
    expand('Preference within selection'); fieldAction('Preferred providers', 'reset')
    saved.mockClear(); await save(); expect(routing).toEqual({})
  })

  it('retains combined only + order on reopen and unrelated save; edits order accessibly', async () => {
    routing = { only: ['azure/east', 'openai'], order: ['openai', 'azure/east'], max_price: { prompt: 0 } }
    await renderDialog()
    expect(getByRole(body(), 'button', { name: 'Only selected' }).getAttribute('aria-pressed')).toBe('true')
    toggle('Zero data retention'); await save()
    expect(routing.order).toEqual(['openai', 'azure/east']); expect(routing.max_price).toEqual({ prompt: 0 })
    flushSync(() => root.render(null)); await renderDialog()
    expand('Preference within selection'); click('Move azure/east up'); saved.mockClear(); await save()
    expect(routing.order).toEqual(['azure/east', 'openai']); expect(routing.only).toEqual(['azure/east', 'openai'])
  })

  it('rejects empty only and preferred lists instead of silently reverting to automatic', async () => {
    await renderDialog(); click('Only selected')
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    click('Prefer providers')
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    click('Add openai to Preferred providers'); await save()
    expect(routing).toEqual({ only: null, order: ['openai'] })
  })

  it('requires explicit clearing of inherited order before sorting, and vice versa', async () => {
    defaults = { order: ['azure'] }; await renderDialog(); strategy('Lowest latency')
    expect(getByText(body(), 'OpenRouter order and sort are mutually exclusive')).toBeTruthy()
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    fieldAction('Preferred providers'); await save(); expect(routing).toEqual({ order: null, sort: 'latency' })
    flushSync(() => root.render(null)); defaults = { sort: 'price' }; routing = {}; await renderDialog()
    click('Prefer providers'); click('Add openai to Preferred providers')
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    expand('Advanced routing'); fieldAction('Routing strategy'); saved.mockClear(); await save()
    expect(routing).toEqual({ only: null, order: ['openai'], sort: null })
  })

  it('searches endpoint slugs and validates allow/exclude conflicts', async () => {
    await renderDialog(); click('Only selected')
    change('Search Allowed providers only', 'azure'); expect(queryByText(body(), 'OpenAI · openai')).toBeNull()
    click('Add azure/east to Allowed providers only')
    expand('Advanced routing'); click('Add excluded providers'); click('Add azure/east to Excluded providers')
    expect(getByText(body(), 'OpenRouter allowed providers conflict with excluded providers')).toBeTruthy()
    fieldAction('Excluded providers'); await save(); expect(routing.only).toEqual(['azure/east'])
  })

  it('retains offline custom slugs and permits manual entry', async () => {
    offline = true; routing = { only: ['unknown/saved'] }; await renderDialog()
    expect(getByText(body(), 'unknown/saved')).toBeTruthy()
    expect(getByText(body(), 'Unverified selection (retained)')).toBeTruthy()
    change('Search Allowed providers only', 'manual/new'); click('Add slug')
    await save(); expect(routing.only).toEqual(['unknown/saved', 'manual/new'])
    expect(body().textContent).not.toContain('ZDR eligible*')
  })

  it('marks cached metadata stale on refresh failure without losing selections', async () => {
    routing = { only: ['azure/east'] }; await renderDialog()
    expect(getByText(body(), 'ZDR eligible*')).toBeTruthy()
    offline = true; expand('Scope & privacy details'); click('Refresh endpoints')
    await waitFor(() => expect(getByText(body(), /Endpoint discovery unavailable. Selections remain/)).toBeTruthy())
    expect(queryByText(body(), 'ZDR eligible*')).toBeNull(); expect(getByText(body(), 'azure/east')).toBeTruthy()
  })

  it('validates prices, preserves zero, replaces objects, and supports multiple quantizations', async () => {
    defaults = { max_price: { prompt: 1, completion: 2 }, quantizations: ['fp16'] }
    await renderDialog(); expand('Advanced routing'); change('Input price ceiling', '-1')
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    change('Input price ceiling', '0'); change('Output price ceiling', '')
    for (const name of ['fp8', 'bf16']) flushSync(() => fireEvent.click(getByLabelText(body(), name)))
    toggle('Require parameter support'); toggle('Provider fallback')
    await save(); expect(routing).toEqual({ max_price: { prompt: 0 }, quantizations: ['fp16', 'fp8', 'bf16'], require_parameters: true, allow_fallbacks: false })
    flushSync(() => root.render(null)); await renderDialog(); expand('Advanced routing')
    fieldAction('Price ceilings', 'reset'); fieldAction('Allowed quantizations'); saved.mockClear(); await save()
    expect(routing.max_price).toBeUndefined(); expect(routing.quantizations).toBeNull()
  })

  it('distinguishes inherited, explicit false, clear, and reset in source menus', async () => {
    await renderDialog()
    expect(getByRole(body(), 'button', { name: 'Zero data retention source: Default' })).toBeTruthy()
    toggle('Zero data retention'); toggle('Zero data retention')
    expect(getByRole(body(), 'button', { name: 'Zero data retention source: Override' })).toBeTruthy()
    await save(); expect(routing.zdr).toBe(false)
    flushSync(() => root.render(null)); await renderDialog()
    fieldAction('Zero data retention'); saved.mockClear(); await save(); expect(routing.zdr).toBeNull()
    expect(getByRole(body(), 'button', { name: 'Zero data retention source: Cleared' })).toBeTruthy()
    flushSync(() => root.render(null)); await renderDialog()
    fieldAction('Zero data retention', 'reset'); saved.mockClear(); await save(); expect(routing).toEqual({})
  })

  it('resets every field independently without changing unrelated overrides', async () => {
    routing = { zdr: true, data_collection: 'deny', only: ['openai'], order: ['openai'], ignore: ['other'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 4 }, quantizations: ['fp8', 'bf16'] }
    await renderDialog(); expand('Advanced routing'); expand('Preference within selection')
    fieldAction('Provider fallback', 'reset'); fieldAction('Require parameter support', 'reset')
    fieldAction('Preferred providers', 'reset'); fieldAction('Excluded providers', 'reset')
    fieldAction('Block data collection', 'reset'); fieldAction('Price ceilings', 'reset')
    fieldAction('Allowed quantizations', 'reset'); fieldAction('Allowed providers only', 'reset')
    await save(); expect(routing).toEqual({ zdr: true })
  })

  it('replaces an inherited provider list when editing, and clears the last quantization explicitly', async () => {
    defaults = { only: ['azure/east', 'openai'], quantizations: ['fp8'] }
    await renderDialog(); click('Remove azure/east from Allowed providers only')
    expand('Advanced routing'); flushSync(() => fireEvent.click(getByLabelText(body(), 'fp8')))
    await save(); expect(routing).toEqual({ only: ['openai'], quantizations: null })
  })

  it('preserves drafts on 409, disables resave, and explicitly reloads before review', async () => {
    await renderDialog(); toggle('Zero data retention'); conflict = true; click('Save changes')
    await waitFor(() => expect(getByText(body(), /Routing changed elsewhere/)).toBeTruthy())
    expect(getByRole(body(), 'switch', { name: 'Zero data retention' }).getAttribute('aria-checked')).toBe('true')
    expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    defaults = { data_collection: 'deny' }; conflict = false; click('Reload settings')
    await waitFor(() => expect(getByRole(body(), 'switch', { name: 'Zero data retention' }).getAttribute('aria-checked')).toBe('false'))
    expect(preview()).toContain('No provider collection')
  })

  it('live model_config_changed retains the open draft until explicit reload', async () => {
    await renderDialog(); toggle('Provider fallback'); defaults = { zdr: true }
    await renderDialog(modelId, 1)
    expect(getByRole(body(), 'switch', { name: 'Provider fallback' }).getAttribute('aria-checked')).toBe('false')
    expect(getByRole(body(), 'button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    click('Reload settings'); await waitFor(() => expect(preview()).toContain('ZDR required'))
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
    expect(queryByText(body(), 'Save changes')).toBeNull()
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

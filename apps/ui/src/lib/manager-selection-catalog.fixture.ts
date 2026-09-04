import {
  MANAGER_SELECTION_CATALOG_VERSION,
  type ManagerModelOption,
  type ManagerSelectionCatalogResponse,
  type WorkModeOption,
} from '@forge/protocol'

function reasoning(
  ids: Array<ManagerModelOption['reasoningOptions'][number]['id']>,
): ManagerModelOption['reasoningOptions'] {
  const labels: Record<string, string> = {
    none: 'None',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: ids.includes('max') ? 'Extra High' : 'Max',
    max: 'Max',
    ultra: 'Ultra',
  }
  return ids.map((id) => ({ id, label: labels[id] ?? id }))
}

function model(
  option: Omit<ManagerModelOption, 'reasoningOptions' | 'surfaces' | 'defaultReasoningId'> & {
    reasoningIds: Array<ManagerModelOption['reasoningOptions'][number]['id']>
    defaultReasoningId: ManagerModelOption['defaultReasoningId']
    selectable?: boolean
    unavailableReason?: NonNullable<ManagerModelOption['surfaces']['create']>['unavailableReason']
    createSelectable?: boolean
    changeSelectable?: boolean
  },
): ManagerModelOption {
  const createSelectable = option.createSelectable ?? option.selectable ?? true
  const changeSelectable = option.changeSelectable ?? option.selectable ?? true
  const unavailableReason = option.unavailableReason
  return {
    provider: option.provider,
    providerLabel: option.providerLabel,
    modelId: option.modelId,
    label: option.label,
    ...(option.familyId ? { familyId: option.familyId } : {}),
    ...(option.familyLabel ? { familyLabel: option.familyLabel } : {}),
    ...(option.description ? { description: option.description } : {}),
    reasoningOptions: reasoning(option.reasoningIds),
    defaultReasoningId: option.defaultReasoningId,
    surfaces: {
      create: createSelectable
        ? { selectable: true }
        : { selectable: false, unavailableReason: unavailableReason ?? 'disabled' },
      change: changeSelectable
        ? { selectable: true }
        : { selectable: false, unavailableReason: unavailableReason ?? 'disabled' },
    },
  }
}

export const DEFAULT_WORK_MODES: WorkModeOption[] = [
  {
    id: 'delegation_first',
    label: 'Delegate first',
    description: 'Delegates substantial implementation while retaining small read-only orientation.',
    selectable: true,
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    description: 'Chooses ownership outcome by outcome.',
    selectable: true,
  },
  {
    id: 'hands_on',
    label: 'Hands-on',
    description: 'Owns one cohesive bounded outcome directly.',
    selectable: true,
  },
]

export function makeManagerSelectionCatalog(
  overrides: Partial<ManagerSelectionCatalogResponse> = {},
): ManagerSelectionCatalogResponse {
  return {
    version: MANAGER_SELECTION_CATALOG_VERSION,
    revision: 'msc-v1-test',
    models: [
      model({
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        modelId: 'gpt-5.5',
        label: 'GPT-5.5',
        familyId: 'pi-5.5',
        familyLabel: 'GPT-5.5',
        reasoningIds: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningId: 'xhigh',
      }),
      model({
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        modelId: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        familyId: 'pi-6',
        familyLabel: 'GPT-6 Astra',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        modelId: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        familyId: 'pi-5.6',
        familyLabel: 'GPT-5.6',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningId: 'max',
      }),
      model({
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        modelId: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        familyId: 'pi-5.6',
        familyLabel: 'GPT-5.6',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
        modelId: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        familyId: 'pi-5.6',
        familyLabel: 'GPT-5.6',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-opus-5',
        label: 'Claude Opus 5',
        familyId: 'pi-opus',
        familyLabel: 'Claude Opus',
        reasoningIds: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-opus-4-7',
        label: 'Claude Opus 4.7',
        familyId: 'pi-opus',
        familyLabel: 'Claude Opus',
        reasoningIds: ['low', 'medium', 'high'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        familyId: 'pi-opus',
        familyLabel: 'Claude Opus',
        reasoningIds: ['low', 'medium', 'high'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-fable-5-1',
        label: 'Claude Fable 5.1',
        familyId: 'pi-fable',
        familyLabel: 'Claude Fable 5.1',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'anthropic',
        providerLabel: 'Anthropic',
        modelId: 'claude-fable-5',
        label: 'Claude Fable 5',
        familyId: 'pi-fable',
        familyLabel: 'Claude Fable 5.1',
        reasoningIds: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'xai',
        providerLabel: 'xAI',
        modelId: 'grok-4.6',
        label: 'Grok 4.6',
        familyId: 'pi-grok',
        familyLabel: 'Grok',
        reasoningIds: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningId: 'high',
      }),
      model({
        provider: 'xai',
        providerLabel: 'xAI',
        modelId: 'grok-4.5',
        label: 'Grok 4.5',
        familyId: 'pi-grok',
        familyLabel: 'Grok',
        reasoningIds: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningId: 'high',
      }),
    ],
    workModes: DEFAULT_WORK_MODES,
    defaults: {
      createManagerModel: {
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        reasoningId: 'xhigh',
      },
      workModeId: 'delegation_first',
    },
    ...overrides,
  }
}

export const FUTURE_MODEL = model({
  provider: 'future-labs',
  providerLabel: 'Future Labs',
  modelId: 'oracle-9',
  label: 'Oracle 9',
  familyId: 'oracle',
  familyLabel: 'Oracle',
  reasoningIds: ['low', 'high', 'ultra'],
  defaultReasoningId: 'high',
})

export const FUTURE_WORK_MODE: WorkModeOption = {
  id: 'review_led',
  label: 'Review led',
  description: 'A future server-defined mode.',
  selectable: true,
}

export const OPENROUTER_GLM = model({
  provider: 'openrouter',
  providerLabel: 'OpenRouter',
  modelId: 'z-ai/glm-5.1',
  label: 'Z.ai: GLM 5.1',
  familyId: 'openrouter',
  familyLabel: 'OpenRouter',
  reasoningIds: ['none', 'low', 'medium', 'high'],
  defaultReasoningId: 'medium',
})

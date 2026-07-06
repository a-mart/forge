export interface KnowledgeV2IndexCaps {
  global: number
  profile: number
}

export interface KnowledgeV2Settings {
  enabled: boolean
  legacyCleanupConfirmed: boolean
  indexCaps: KnowledgeV2IndexCaps
  updatedAt: string | null
}

export interface KnowledgeV2SettingsConstraints {
  indexCaps: {
    min: number
    max: number
    defaults: KnowledgeV2IndexCaps
  }
}

export type UpdateKnowledgeV2SettingsRequest = Partial<
  Pick<KnowledgeV2Settings, 'enabled' | 'legacyCleanupConfirmed'>
> & {
  indexCaps?: Partial<KnowledgeV2IndexCaps>
}

export interface GetKnowledgeV2SettingsResponse {
  settings: KnowledgeV2Settings
  defaults: KnowledgeV2Settings
  constraints: KnowledgeV2SettingsConstraints
}

export interface UpdateKnowledgeV2SettingsResponse extends GetKnowledgeV2SettingsResponse {
  ok: true
}

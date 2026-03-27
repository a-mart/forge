export interface CortexAutoReviewSettings {
  enabled: boolean
  intervalMinutes: number
  updatedAt: string | null
}

export interface GetCortexAutoReviewSettingsResponse {
  settings: CortexAutoReviewSettings
}

export interface UpdateCortexAutoReviewSettingsRequest {
  enabled?: boolean
  intervalMinutes?: number
}

export interface UpdateCortexAutoReviewSettingsResponse {
  ok: true
  settings: CortexAutoReviewSettings
}

export type CortexAutoReviewCadenceHours = 24

export interface CortexAutoReviewSettings {
  enabled: boolean
  intervalMinutes: number
  updatedAt: string | null
}

export interface UpdateCortexAutoReviewSettingsRequest {
  enabled?: boolean
  intervalMinutes?: number
}

export interface GetCortexAutoReviewSettingsResponse {
  settings: CortexAutoReviewSettings
}

export interface UpdateCortexAutoReviewSettingsResponse {
  ok: true
  settings: CortexAutoReviewSettings
}

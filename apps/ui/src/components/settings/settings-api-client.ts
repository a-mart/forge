/**
 * Settings API client abstraction.
 *
 * All settings HTTP requests go through this client so that the correct
 * backend base URL and credentials policy are applied consistently.
 * Builder settings use local same-origin requests; Collab settings use
 * credentialed cross-origin requests to the remote Collab backend.
 */

import type { SettingsBackendTarget } from './settings-target'
import { createBuilderSettingsTarget } from './settings-target'

/* ------------------------------------------------------------------ */
/*  Interface                                                          */
/* ------------------------------------------------------------------ */

export interface SettingsApiClient {
  readonly target: SettingsBackendTarget

  /** Resolve an API path to a fully qualified URL against the target backend. */
  endpoint(path: string): string

  /** Fetch with automatic credentials policy from the target. */
  fetch(path: string, init?: RequestInit): Promise<Response>

  /** Fetch + parse JSON with automatic credentials policy. */
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>

  /** Read an error message from a failed response. */
  readApiError(response: Response): Promise<string>
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

class SettingsApiClientImpl implements SettingsApiClient {
  constructor(readonly target: SettingsBackendTarget) {}

  endpoint(path: string): string {
    try {
      return new URL(path, this.target.apiBaseUrl).toString()
    } catch {
      return path
    }
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = this.endpoint(path)

    // Apply target credentials unless caller explicitly overrides
    const mergedInit: RequestInit = {
      ...init,
      credentials: init?.credentials ?? this.target.fetchCredentials,
    }

    return globalThis.fetch(url, mergedInit)
  }

  async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init)
    if (!response.ok) {
      throw new Error(await this.readApiError(response))
    }
    return (await response.json()) as T
  }

  async readApiError(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: unknown; message?: unknown }
      if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
      if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
    } catch { /* ignore */ }
    try {
      const text = await response.text()
      if (text.trim().length > 0) return text
    } catch { /* ignore */ }
    return `Request failed (${response.status})`
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Create a settings API client for the given target. */
export function createSettingsApiClient(target: SettingsBackendTarget): SettingsApiClient {
  return new SettingsApiClientImpl(target)
}

/**
 * Create a Builder-mode settings API client from a raw wsUrl.
 *
 * Convenience adapter for call sites that haven't been migrated to full
 * target-aware plumbing yet. Settings paths should use target-aware clients.
 */
export function createBuilderSettingsApiClient(wsUrl: string): SettingsApiClient {
  return new SettingsApiClientImpl(createBuilderSettingsTarget(wsUrl))
}

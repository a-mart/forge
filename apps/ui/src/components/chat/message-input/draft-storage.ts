import type { PendingAttachment } from '@/lib/file-attachments'

const DRAFTS_STORAGE_KEY = 'forge-chat-drafts'
const FORMAT_MODE_STORAGE_KEY = 'forge-chat-format-mode'
const ATTACHMENT_DRAFTS_STORAGE_KEY = 'forge-chat-attachment-drafts'

/** Max serialized size (bytes) we'll commit to localStorage for attachment drafts. */
const ATTACHMENT_DRAFTS_MAX_BYTES = 4 * 1024 * 1024

// --- Format mode ---

export function loadFormatMode(): boolean {
  try {
    return localStorage.getItem(FORMAT_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function persistFormatMode(value: boolean): void {
  try {
    localStorage.setItem(FORMAT_MODE_STORAGE_KEY, String(value))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Text drafts ---

export function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

export function persistDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// --- Attachment drafts ---

export function loadAttachmentDrafts(): Record<string, PendingAttachment[]> {
  try {
    const raw = localStorage.getItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, PendingAttachment[]>
    }
    return {}
  } catch {
    return {}
  }
}

export function persistAttachmentDrafts(drafts: Record<string, PendingAttachment[]>): void {
  try {
    const cleaned: Record<string, PendingAttachment[]> = {}
    for (const [key, value] of Object.entries(drafts)) {
      if (value.length > 0) cleaned[key] = value
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
      return
    }
    const serialized = JSON.stringify(cleaned)
    if (serialized.length > ATTACHMENT_DRAFTS_MAX_BYTES) {
      // Too large for localStorage — keep in-memory only, don't persist
      return
    }
    localStorage.setItem(ATTACHMENT_DRAFTS_STORAGE_KEY, serialized)
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

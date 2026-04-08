import type { DirectoryItem } from './shared-types.js'

export interface DirectoriesListedEvent {
  type: 'directories_listed'
  path: string
  directories: string[]
  requestId?: string
  requestedPath?: string
  resolvedPath?: string
  roots?: string[]
  entries?: DirectoryItem[]
}

export interface DirectoryValidatedEvent {
  type: 'directory_validated'
  path: string
  valid: boolean
  message?: string
  requestId?: string
  requestedPath?: string
  roots?: string[]
  resolvedPath?: string
}

export interface DirectoryPickedEvent {
  type: 'directory_picked'
  path: string | null
  requestId?: string
}

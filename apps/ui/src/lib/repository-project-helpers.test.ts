import { describe, expect, it } from 'vitest'
import {
  deriveRepositoryFolderFromUrl,
  formatCloneStageLabel,
  joinRepositoryDestination,
} from './repository-project-helpers'

describe('repository-project-helpers', () => {
  it('derives folder names from common URL forms', () => {
    expect(deriveRepositoryFolderFromUrl('https://github.com/org/repo.git')).toBe('repo')
    expect(deriveRepositoryFolderFromUrl('git@github.com:org/Cool-Repo.git')).toBe('Cool-Repo')
  })

  it('joins destination previews', () => {
    expect(joinRepositoryDestination('/Users/me/repos', 'repo')).toBe('/Users/me/repos/repo')
  })

  it('formats clone stage labels', () => {
    expect(formatCloneStageLabel('cloning', 42)).toBe('Cloning repository… 42%')
    expect(formatCloneStageLabel('creating_manager')).toBe('Creating project…')
  })
})

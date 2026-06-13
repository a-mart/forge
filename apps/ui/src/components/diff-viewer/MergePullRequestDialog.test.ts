/** @vitest-environment jsdom */

import { getByRole, getByText, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MergePullRequestDialog } from './MergePullRequestDialog'
import type { GitPullRequestDetail } from '@forge/protocol'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
})

const baseDetail: GitPullRequestDetail = {
  number: 428,
  title: 'Enhanced Source Control workspace',
  state: 'open',
  author: 'adam',
  createdAt: '2026-06-10T10:00:00Z',
  updatedAt: '2026-06-12T09:00:00Z',
  headRef: 'feature/git-source-control-workspace',
  baseRef: 'main',
  isDraft: false,
  isCurrentBranch: true,
  checkStatus: 'success',
  body: 'Body',
  mergeable: true,
  checks: [],
  changedFiles: 3,
  additions: 10,
  deletions: 2,
  headSha: 'abc123def456',
  allowedMergeMethods: ['squash', 'merge', 'rebase'],
}

describe('MergePullRequestDialog', () => {
  it('blocks confirmation when checks are failing until acknowledged', () => {
    renderDialog({
      pullRequest: {
        ...baseDetail,
        checkStatus: 'failure',
        checks: [{ name: 'Backend tests', status: 'failure' }],
      },
    })

    const confirmButton = getByRole(document.body, 'button', {
      name: /Merge pull request/i,
      hidden: true,
    })
    expect(confirmButton.hasAttribute('disabled')).toBe(true)
    expect(getByText(document.body, /Confirm merge anyway to continue/i)).toBeTruthy()
  })

  it('allows confirmation after explicit check-failure acknowledgement', () => {
    renderDialog({
      pullRequest: {
        ...baseDetail,
        checkStatus: 'failure',
      },
    })

    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
    checkbox.click()

    const confirmButton = getByRole(document.body, 'button', {
      name: /Merge pull request/i,
      hidden: true,
    })
    expect(confirmButton.hasAttribute('disabled')).toBe(false)
  })

  it('does not render when pull request detail is missing', () => {
    renderDialog({ pullRequest: null })
    expect(
      queryByRole(document.body, 'button', { name: /Merge pull request/i, hidden: true }),
    ).toBeNull()
  })
})

function renderDialog(options: {
  pullRequest: GitPullRequestDetail | null
  onConfirm?: () => void
}) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(MergePullRequestDialog, {
        open: true,
        pullRequest: options.pullRequest,
        onConfirm: options.onConfirm ?? (() => undefined),
        onCancel: () => undefined,
      }),
    )
  })
}

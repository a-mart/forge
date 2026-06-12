import type { GitPullRequestDetail, GitPullRequestMergeMethod } from '@forge/protocol'
import { useMemo, useState } from 'react'
import { GitMutationConfirmDialog } from './GitMutationConfirmDialog'

interface MergePullRequestDialogProps {
  open: boolean
  pullRequest: GitPullRequestDetail | null
  isSubmitting?: boolean
  mergeError?: string | null
  onConfirm: (options: {
    method: GitPullRequestMergeMethod
    deleteBranchAfterMerge: boolean
    acknowledgeCheckFailures: boolean
  }) => void
  onCancel: () => void
}

function defaultMergeMethod(detail: GitPullRequestDetail | null): GitPullRequestMergeMethod {
  const allowed = detail?.allowedMergeMethods ?? ['squash', 'merge', 'rebase']
  if (allowed.includes('squash')) {
    return 'squash'
  }
  if (allowed.includes('merge')) {
    return 'merge'
  }
  return allowed[0] ?? 'squash'
}

function mergeMethodLabel(method: GitPullRequestMergeMethod): string {
  if (method === 'squash') {
    return 'Squash and merge'
  }
  if (method === 'rebase') {
    return 'Rebase and merge'
  }
  return 'Create a merge commit'
}

export function MergePullRequestDialog({
  open,
  pullRequest,
  isSubmitting = false,
  mergeError,
  onConfirm,
  onCancel,
}: MergePullRequestDialogProps) {
  const [method, setMethod] = useState<GitPullRequestMergeMethod>(() => defaultMergeMethod(pullRequest))
  const [deleteBranchAfterMerge, setDeleteBranchAfterMerge] = useState(false)
  const [acknowledgeCheckFailures, setAcknowledgeCheckFailures] = useState(false)

  const allowedMethods = pullRequest?.allowedMergeMethods ?? ['squash', 'merge', 'rebase']
  const checkIssues =
    pullRequest?.checkStatus === 'failure' || pullRequest?.checkStatus === 'pending'

  const blockedReasons = useMemo(() => {
    if (!pullRequest) {
      return ['Select a pull request to merge.']
    }

    const reasons: string[] = []
    if (pullRequest.state !== 'open') {
      reasons.push(`Pull request #${pullRequest.number} is ${pullRequest.state}.`)
    }
    if (pullRequest.isDraft) {
      reasons.push('Draft pull requests cannot be merged.')
    }
    if (pullRequest.mergeable === false) {
      reasons.push(
        pullRequest.mergeBlockedReason
          ? `Not mergeable: ${pullRequest.mergeBlockedReason}.`
          : 'Pull request is not mergeable.',
      )
    }
    if (!allowedMethods.includes(method)) {
      reasons.push(`Merge method "${method}" is not allowed for this repository.`)
    }
    if (deleteBranchAfterMerge && pullRequest.isForkPullRequest) {
      reasons.push('Deleting the head branch is not supported for fork pull requests.')
    }
    if (checkIssues && !acknowledgeCheckFailures) {
      if (pullRequest.checkStatus === 'failure') {
        reasons.push('Checks are failing. Confirm merge anyway to continue.')
      } else {
        reasons.push('Checks are still pending. Confirm merge anyway to continue.')
      }
    }

    return reasons
  }, [acknowledgeCheckFailures, allowedMethods, checkIssues, deleteBranchAfterMerge, method, pullRequest])

  const warnings = useMemo(() => {
    const items: string[] = []
    if (pullRequest?.mergeBlockedReason) {
      items.push(`GitHub merge state: ${pullRequest.mergeBlockedReason}.`)
    }
    if (checkIssues && acknowledgeCheckFailures) {
      items.push('You chose to proceed despite incomplete or failing checks. GitHub branch protection may still block the merge.')
    }
    if (mergeError) {
      items.push(mergeError)
    }
    return items
  }, [acknowledgeCheckFailures, checkIssues, mergeError, pullRequest?.mergeBlockedReason])

  if (!pullRequest) {
    return null
  }

  return (
    <GitMutationConfirmDialog
      open={open}
      title={`Merge pull request #${pullRequest.number}?`}
      description={`This will merge ${pullRequest.headRef} into ${pullRequest.baseRef} on GitHub using the selected merge method. Forge re-checks the latest PR head commit before sending the merge.`}
      warnings={warnings}
      blockedReasons={blockedReasons}
      confirmLabel="Merge pull request"
      isSubmitting={isSubmitting}
      onConfirm={() =>
        onConfirm({
          method,
          deleteBranchAfterMerge,
          acknowledgeCheckFailures,
        })
      }
      onCancel={onCancel}
      extraContent={
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="merge-method" className="text-xs font-medium text-foreground">
              Merge method
            </label>
            <select
              id="merge-method"
              className="h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs"
              value={method}
              onChange={(event) => setMethod(event.target.value as GitPullRequestMergeMethod)}
            >
              {allowedMethods.map((entry) => (
                <option key={entry} value={entry}>
                  {mergeMethodLabel(entry)}
                </option>
              ))}
            </select>
          </div>
          {checkIssues ? (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledgeCheckFailures}
                onChange={(event) => setAcknowledgeCheckFailures(event.target.checked)}
              />
              <span>
                I understand checks are {pullRequest.checkStatus === 'failure' ? 'failing' : 'pending'} and want to
                attempt merge anyway.
              </span>
            </label>
          ) : null}
          {!pullRequest.isForkPullRequest ? (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={deleteBranchAfterMerge}
                onChange={(event) => setDeleteBranchAfterMerge(event.target.checked)}
              />
              <span>Delete the head branch on GitHub after merge (optional).</span>
            </label>
          ) : null}
          <p className="font-mono text-[11px] text-muted-foreground">Head SHA: {pullRequest.headSha}</p>
        </div>
      }
    />
  )
}

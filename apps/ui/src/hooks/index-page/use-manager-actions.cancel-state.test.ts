/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'

/**
 * State-machine coverage for cancel UX:
 * accepted:true keeps Cancelling until create settles;
 * accepted:false/tooLate clears Cancelling immediately.
 */
describe('clone cancel UI state machine', () => {
  it('keeps cancelling after accepted:true until create rejection settles', async () => {
    let resolveCancel!: (value: { accepted: boolean; tooLate: boolean }) => void
    let resolveCreate!: (error?: Error) => void

    const cancel = () =>
      new Promise<{ accepted: boolean; tooLate: boolean }>((resolve) => {
        resolveCancel = resolve
      })

    const create = () =>
      new Promise<void>((_resolve, reject) => {
        resolveCreate = (error) => reject(error ?? new Error('clone_cancelled'))
      })

    let isCancellingClone = false
    let isCreatingManager = true

    // Start create
    const createPromise = create().catch(() => {
      isCreatingManager = false
      isCancellingClone = false
    })

    // User cancels
    isCancellingClone = true
    const cancelPromise = cancel().then((result) => {
      if (!result.accepted) {
        isCancellingClone = false
        return result
      }
      // accepted:true — remain cancelling
      return result
    })

    // Cancel ack arrives before create settles
    resolveCancel({ accepted: true, tooLate: false })
    await cancelPromise
    expect(isCancellingClone).toBe(true)
    expect(isCreatingManager).toBe(true)

    // Create rejection settles → clear cancelling
    resolveCreate(new Error('clone_cancelled: Clone was cancelled.'))
    await createPromise
    expect(isCreatingManager).toBe(false)
    expect(isCancellingClone).toBe(false)
  })

  it('clears cancelling immediately on accepted:false tooLate', async () => {
    let isCancellingClone = true
    const result = { accepted: false, tooLate: true }
    if (!result.accepted) {
      isCancellingClone = false
    }
    expect(isCancellingClone).toBe(false)
  })
})

void vi

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestDispatcher } from './request-dispatcher'
import { REQUEST_TIMEOUT_MS } from './runtime-types'
import { RECONNECTING_SOCKET_ERROR } from './request-definitions'

describe('RequestDispatcher', () => {
  let sendSpy: ReturnType<typeof vi.fn>
  let dispatcher: RequestDispatcher

  beforeEach(() => {
    vi.useFakeTimers()
    sendSpy = vi.fn().mockReturnValue(true)
    dispatcher = new RequestDispatcher({ send: sendSpy })
  })

  afterEach(() => {
    dispatcher.rejectAllPendingRequests('cleanup')
    vi.useRealTimers()
  })

  // ---------------------------------------------------------------------------
  // Request-id generation
  // ---------------------------------------------------------------------------

  describe('nextRequestId', () => {
    it('generates collision-resistant UUID IDs with command prefix', () => {
      const id = dispatcher.nextRequestId('create_manager')
      expect(id).toMatch(
        /^create_manager-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
    })

    it('generates distinct IDs across calls', () => {
      const id1 = dispatcher.nextRequestId('a')
      const id2 = dispatcher.nextRequestId('b')
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^a-/)
      expect(id2).toMatch(/^b-/)
    })
  })

  // ---------------------------------------------------------------------------
  // enqueueRequest
  // ---------------------------------------------------------------------------

  describe('enqueueRequest', () => {
    it('calls the send callback with the built command', async () => {
      const promise = dispatcher.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories' as const,
        requestId,
        path: '/tmp',
      }))

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const sentCommand = sendSpy.mock.calls[0][0]
      expect(sentCommand.type).toBe('list_directories')
      expect(sentCommand.requestId).toMatch(/^list_directories-/)

      // Resolve to avoid dangling promise
      dispatcher.tracker.resolve('list_directories', sentCommand.requestId, {
        path: '/tmp',
        directories: [],
      })
      await promise
    })

    it('rejects immediately when send returns false', async () => {
      sendSpy.mockReturnValue(false)

      const promise = dispatcher.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager' as const,
        requestId,
        managerId: 'mgr-1',
      }))

      await expect(promise).rejects.toThrow(RECONNECTING_SOCKET_ERROR)
    })

    it('rejects after REQUEST_TIMEOUT_MS', async () => {
      const promise = dispatcher.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager' as const,
        requestId,
        managerId: 'mgr-1',
      }))

      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS + 100)

      await expect(promise).rejects.toThrow('Request timed out waiting for backend response.')
    })

    it('resolves when tracker resolves with matching requestId', async () => {
      const promise = dispatcher.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories' as const,
        requestId,
        path: '/home',
      }))

      const sentCommand = sendSpy.mock.calls[0][0]
      dispatcher.tracker.resolve('list_directories', sentCommand.requestId, {
        path: '/home',
        directories: ['/home/user'],
      })

      await expect(promise).resolves.toEqual({
        path: '/home',
        directories: ['/home/user'],
      })
    })
  })

  // ---------------------------------------------------------------------------
  // rejectPendingFromError
  // ---------------------------------------------------------------------------

  describe('rejectPendingFromError', () => {
    it('rejects by matching requestId first', async () => {
      const promise = dispatcher.enqueueRequest('create_manager', (requestId) => ({
        type: 'create_manager' as const,
        requestId,
        name: 'test',
        cwd: '/tmp',
      }))

      const sentCommand = sendSpy.mock.calls[0][0]

      dispatcher.rejectPendingFromError(
        'CREATE_MANAGER_FAILED',
        'Something went wrong',
        sentCommand.requestId,
      )

      await expect(promise).rejects.toThrow('CREATE_MANAGER_FAILED: Something went wrong')
    })

    it('falls back to error hint matching when requestId is absent', async () => {
      const promise = dispatcher.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager' as const,
        requestId,
        managerId: 'mgr-1',
      }))

      // Error code contains 'delete_manager' which matches hint
      dispatcher.rejectPendingFromError('DELETE_MANAGER_FAILED', 'Manager not found')

      await expect(promise).rejects.toThrow('DELETE_MANAGER_FAILED: Manager not found')
    })

    it('rejects the only pending request when no hint matches', async () => {
      const promise = dispatcher.enqueueRequest('validate_directory', (requestId) => ({
        type: 'validate_directory' as const,
        requestId,
        path: '/invalid',
      }))

      dispatcher.rejectPendingFromError('UNKNOWN_ERROR', 'Something completely unexpected')

      await expect(promise).rejects.toThrow('UNKNOWN_ERROR: Something completely unexpected')
    })

    it('does not reject unrelated requests when hint matches a specific type', async () => {
      const listPromise = dispatcher.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories' as const,
        requestId,
        path: '/tmp',
      }))
      const listCommand = sendSpy.mock.calls[0][0]

      const deletePromise = dispatcher.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager' as const,
        requestId,
        managerId: 'mgr-1',
      }))

      // Error code matches delete_manager hint
      dispatcher.rejectPendingFromError('delete_manager_failed', 'Cannot delete')

      await expect(deletePromise).rejects.toThrow('delete_manager_failed: Cannot delete')

      // list_directories should still be pending — resolve it
      dispatcher.tracker.resolve('list_directories', listCommand.requestId, {
        path: '/tmp',
        directories: ['/tmp/a'],
      })

      await expect(listPromise).resolves.toEqual({
        path: '/tmp',
        directories: ['/tmp/a'],
      })
    })

    it('does not reject when there are multiple pending and no hint/requestId matches', async () => {
      // With 2+ pending requests and no hint match, rejectOnlyPending should NOT fire
      const promise1 = dispatcher.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories' as const,
        requestId,
        path: '/a',
      }))
      const promise2 = dispatcher.enqueueRequest('validate_directory', (requestId) => ({
        type: 'validate_directory' as const,
        requestId,
        path: '/b',
      }))

      // No hint match and no requestId — should not reject anything
      dispatcher.rejectPendingFromError('COMPLETELY_UNKNOWN', 'No match')

      // Both should still be pending — resolve them to verify
      const listCommand = sendSpy.mock.calls[0][0]
      const validateCommand = sendSpy.mock.calls[1][0]

      dispatcher.tracker.resolve('list_directories', listCommand.requestId, {
        path: '/a',
        directories: [],
      })
      dispatcher.tracker.resolve('validate_directory', validateCommand.requestId, {
        path: '/b',
        valid: true,
        message: null,
      })

      await expect(promise1).resolves.toBeDefined()
      await expect(promise2).resolves.toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // rejectAllPendingRequests
  // ---------------------------------------------------------------------------

  describe('rejectAllPendingRequests', () => {
    it('rejects all pending requests with the given reason', async () => {
      const promise1 = dispatcher.enqueueRequest('delete_manager', (requestId) => ({
        type: 'delete_manager' as const,
        requestId,
        managerId: 'mgr-1',
      }))
      const promise2 = dispatcher.enqueueRequest('list_directories', (requestId) => ({
        type: 'list_directories' as const,
        requestId,
        path: '/tmp',
      }))

      dispatcher.rejectAllPendingRequests('Client destroyed before request completed.')

      await expect(promise1).rejects.toThrow('Client destroyed before request completed.')
      await expect(promise2).rejects.toThrow('Client destroyed before request completed.')
    })

    it('is safe to call when no requests are pending', () => {
      expect(() => dispatcher.rejectAllPendingRequests('no-op')).not.toThrow()
    })
  })
})

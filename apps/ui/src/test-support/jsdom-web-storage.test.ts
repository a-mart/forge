/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'

describe('jsdom web storage environment', () => {
  it('exposes isolated localStorage and sessionStorage APIs', () => {
    expect(localStorage).toBeDefined()
    expect(sessionStorage).toBeDefined()
    expect(window.localStorage).toBe(localStorage)
    expect(window.sessionStorage).toBe(sessionStorage)

    localStorage.setItem('local-key', 'local-value')
    sessionStorage.setItem('session-key', 'session-value')

    expect(localStorage.getItem('local-key')).toBe('local-value')
    expect(sessionStorage.getItem('session-key')).toBe('session-value')
    expect(localStorage.getItem('session-key')).toBeNull()
    expect(sessionStorage.getItem('local-key')).toBeNull()
    expect(localStorage.length).toBe(1)
    expect(sessionStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe('local-key')
    expect(sessionStorage.key(0)).toBe('session-key')

    localStorage.removeItem('local-key')
    expect(localStorage.getItem('local-key')).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.getItem('session-key')).toBe('session-value')
  })

  it('does not leak storage writes from the previous test', () => {
    expect(localStorage.getItem('local-key')).toBeNull()
    expect(sessionStorage.getItem('session-key')).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)

    localStorage.setItem('next-local', 'kept-until-reset')
    sessionStorage.setItem('next-session', 'kept-until-reset')
    expect(localStorage.getItem('next-local')).toBe('kept-until-reset')
    expect(sessionStorage.getItem('next-session')).toBe('kept-until-reset')
  })

  it('does not leak the follow-up writes either', () => {
    expect(localStorage.getItem('next-local')).toBeNull()
    expect(sessionStorage.getItem('next-session')).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

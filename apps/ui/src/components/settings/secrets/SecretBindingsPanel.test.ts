import { describe, expect, it } from 'vitest'
import { isValidBindingTarget } from './binding-target'

describe('SecretBindingsPanel file targets', () => {
  it('accepts only canonical paths below the secure bindings root', () => {
    expect(
      isValidBindingTarget('file', '/run/forge-secure/bindings/github-token'),
    ).toBe(true)
    expect(
      isValidBindingTarget('file', '/run/forge-secure/bindings/nested/token'),
    ).toBe(true)

    expect(isValidBindingTarget('file', '/tmp/github-token')).toBe(false)
    expect(isValidBindingTarget('file', '/run/forge-secure/github-token')).toBe(false)
    expect(isValidBindingTarget('file', '/run/forge-secure/bindings')).toBe(false)
    expect(isValidBindingTarget('file', '/run/forge-secure/bindings/../token')).toBe(false)
    expect(isValidBindingTarget('file', '/run/forge-secure/bindings//token')).toBe(false)
    expect(
      isValidBindingTarget(
        'file',
        '/run/forge-secure/bindings/.forge-ssh/known_hosts',
      ),
    ).toBe(false)
  })

  it('does not require a target name for execution-owned SSH-agent delivery', () => {
    expect(isValidBindingTarget('ssh_agent', '')).toBe(true)
  })
})

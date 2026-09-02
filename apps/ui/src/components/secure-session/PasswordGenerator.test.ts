/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PasswordGenerator,
} from './PasswordGenerator'
import {
  generatePassphrase,
  generateRandomPassword,
} from './password-generator-core'

describe('PasswordGenerator', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
  })

  it('generates the requested random length with every enabled character type', () => {
    const value = generateRandomPassword({
      length: 48,
      lowercase: true,
      uppercase: true,
      numbers: true,
      symbols: true,
      avoidAmbiguous: true,
    })

    expect(value).toHaveLength(48)
    expect(value).toMatch(/[a-z]/u)
    expect(value).toMatch(/[A-Z]/u)
    expect(value).toMatch(/[0-9]/u)
    expect(value).toMatch(/[!@#$%^&*()\-_=+\[\]{}:,.?]/u)
    expect(value).not.toMatch(/[Il1O0o|`'"]/u)
  })

  it('generates a configurable phrase with capitalization, separator, and number', () => {
    const value = generatePassphrase({
      wordCount: 7,
      separator: '_',
      capitalize: true,
      includeNumber: true,
    })
    const parts = value.split('_')

    expect(parts).toHaveLength(8)
    expect(parts.slice(0, 7).every((part) => /^[A-Z][a-z]+$/u.test(part))).toBe(true)
    expect(parts[7]).toMatch(/^\d{4}$/u)
  })

  it('uses safe defaults when an editable numeric field is temporarily empty', () => {
    expect(generateRandomPassword({
      length: Number.NaN,
      lowercase: true,
      uppercase: false,
      numbers: false,
      symbols: false,
      avoidAmbiguous: true,
    })).toHaveLength(24)
    expect(generatePassphrase({
      wordCount: Number.NaN,
      separator: '-',
      capitalize: false,
      includeNumber: false,
    }).split('-')).toHaveLength(8)
  })

  it('places a refreshed generated value into its caller', () => {
    const onGenerate = vi.fn()
    flushSync(() => root.render(createElement(PasswordGenerator, { onGenerate })))

    fireEvent.change(getByLabelText(container, 'Length'), { target: { value: '36' } })
    fireEvent.click(getByRole(container, 'button', { name: 'Generate / refresh' }))
    fireEvent.click(getByRole(container, 'button', { name: 'Generate / refresh' }))

    expect(onGenerate).toHaveBeenCalledTimes(2)
    expect(onGenerate.mock.calls[0]![0]).toHaveLength(36)
    expect(onGenerate.mock.calls[1]![0]).toHaveLength(36)
    expect(onGenerate.mock.calls[0]![0]).not.toBe(onGenerate.mock.calls[1]![0])
  })
})

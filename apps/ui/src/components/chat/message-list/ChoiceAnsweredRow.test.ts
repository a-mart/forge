/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChoiceAnswer, ChoiceQuestion } from '@forge/protocol'
import { ChoiceAnsweredRow } from './ChoiceAnsweredRow'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function render(questions: ChoiceQuestion[], answers: ChoiceAnswer[]) {
  act(() => {
    root.render(
      createElement(ChoiceAnsweredRow, {
        choiceId: 'choice-1',
        questions,
        answers,
        status: 'answered',
        timestamp: '2026-04-12T12:34:56.000Z',
      }),
    )
  })
}

describe('ChoiceAnsweredRow multi-select rendering', () => {
  const questions: ChoiceQuestion[] = [
    {
      id: 'q1',
      question: 'Pick multiple',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ],
    },
  ]

  const answers: ChoiceAnswer[] = [
    {
      questionId: 'q1',
      selectedOptionIds: ['a', 'c'],
    },
  ]

  it('shows all selected labels in collapsed summary', () => {
    render(questions, answers)
    expect(container.textContent).toContain('Choice: Alpha, Gamma')
  })

  it('marks multiple options as selected in expanded details', () => {
    render(questions, answers)
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(toggle).toBeTruthy()

    act(() => {
      toggle?.click()
    })

    const expandedContent = container.textContent ?? ''
    expect(expandedContent).toContain('● Alpha')
    expect(expandedContent).toContain('○ Beta')
    expect(expandedContent).toContain('● Gamma')
  })
})

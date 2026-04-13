/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChoiceQuestion } from '@forge/protocol'
import { ChoiceRequestCard } from './ChoiceRequestCard'

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
  vi.restoreAllMocks()
})

function render(questions: ChoiceQuestion[], onSubmit = vi.fn(), onCancel = vi.fn()) {
  act(() => {
    root.render(
      createElement(ChoiceRequestCard, {
        choiceId: 'choice-1',
        agentId: 'agent-1',
        questions,
        onSubmit,
        onCancel,
      }),
    )
  })
  return { onSubmit, onCancel }
}

function optionButtons() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'))
}

function submitButton() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === 'Submit',
  )!
}

// ---------------------------------------------------------------------------
// Single-select (default / no multiSelect)
// ---------------------------------------------------------------------------

describe('single-select', () => {
  const questions: ChoiceQuestion[] = [
    {
      id: 'q1',
      question: 'Pick one',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    },
  ]

  it('clicking an option selects it', () => {
    render(questions)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking the same option again deselects it', () => {
    render(questions)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[0].click())
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking a different option replaces the selection', () => {
    render(questions)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  })

  it('submit produces correct ChoiceAnswer shape', () => {
    const onSubmit = vi.fn()
    render(questions, onSubmit)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => submitButton().click())
    expect(onSubmit).toHaveBeenCalledWith('agent-1', 'choice-1', [
      { questionId: 'q1', selectedOptionIds: ['a'], text: undefined },
    ])
  })

  it('does not render checkbox icons for single-select', () => {
    render(questions)
    // CheckSquare / Square icons should NOT be present
    const svgs = container.querySelectorAll('button[aria-pressed] svg')
    expect(svgs.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

describe('multi-select', () => {
  const questions: ChoiceQuestion[] = [
    {
      id: 'q1',
      question: 'Pick multiple',
      multiSelect: true,
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
        { id: 'c', label: 'Gamma' },
      ],
    },
  ]

  it('clicking toggles options in and out', () => {
    render(questions)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2].getAttribute('aria-pressed')).toBe('false')

    // Deselect first
    act(() => buttons[0].click())
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  })

  it('respects maxSelections cap', () => {
    const questionsWithMax: ChoiceQuestion[] = [
      { ...questions[0], maxSelections: 2 },
    ]
    render(questionsWithMax)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    act(() => buttons[2].click()) // Should be ignored
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[2].getAttribute('aria-pressed')).toBe('false')
  })

  it('submit disabled when below minSelections', () => {
    const questionsWithMin: ChoiceQuestion[] = [
      { ...questions[0], minSelections: 2 },
    ]
    render(questionsWithMin)
    expect(submitButton().disabled).toBe(true)

    const buttons = optionButtons()
    act(() => buttons[0].click())
    expect(submitButton().disabled).toBe(true)

    act(() => buttons[1].click())
    expect(submitButton().disabled).toBe(false)
  })

  it('submit produces correct ChoiceAnswer with multiple selections', () => {
    const onSubmit = vi.fn()
    render(questions, onSubmit)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[2].click())
    act(() => submitButton().click())
    expect(onSubmit).toHaveBeenCalledWith('agent-1', 'choice-1', [
      { questionId: 'q1', selectedOptionIds: ['a', 'c'], text: undefined },
    ])
  })

  it('renders checkbox icons for multi-select options', () => {
    render(questions)
    // All options should have Square icons (unchecked)
    const svgs = container.querySelectorAll('button[aria-pressed] svg')
    expect(svgs.length).toBe(3)
  })

  it('shows multi-select hint text', () => {
    render(questions)
    expect(container.textContent).toContain('Select one or more')
  })

  it('shows constraint hints for min and max', () => {
    const constrained: ChoiceQuestion[] = [
      { ...questions[0], minSelections: 2, maxSelections: 3 },
    ]
    render(constrained)
    expect(container.textContent).toContain('at least 2')
    expect(container.textContent).toContain('up to 3')
  })

  it('maxSelections: 1 with multiSelect still works', () => {
    const questionsMax1: ChoiceQuestion[] = [
      { ...questions[0], maxSelections: 1 },
    ]
    render(questionsMax1)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[1].click()) // Should be ignored — already at max
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false')
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  it('question without multiSelect behaves as single-select', () => {
    const questions: ChoiceQuestion[] = [
      {
        id: 'q1',
        question: 'Legacy question',
        options: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
      },
    ]
    render(questions)
    const buttons = optionButtons()
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    // Should replace, not add
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  })

  it('minSelections clamped to options length', () => {
    const questions: ChoiceQuestion[] = [
      {
        id: 'q1',
        question: 'Few options',
        multiSelect: true,
        minSelections: 10,
        options: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
      },
    ]
    render(questions)
    const buttons = optionButtons()
    // Select both — should satisfy clamped min of 2
    act(() => buttons[0].click())
    act(() => buttons[1].click())
    expect(submitButton().disabled).toBe(false)
  })
})

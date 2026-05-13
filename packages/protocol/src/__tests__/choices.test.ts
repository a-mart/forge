import { describe, expect, it } from 'vitest'
import { isChoiceAnswer, validateChoiceAnswers, type ChoiceAnswer, type ChoiceQuestion } from '../choices.js'

const questions: ChoiceQuestion[] = [
  { id: 'single', question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { id: 'multi', question: 'Pick several', multiSelect: true, minSelections: 1, maxSelections: 2, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }] },
  { id: 'free', question: 'Explain' },
]

describe('choice answer validation', () => {
  it('recognizes structural ChoiceAnswer values', () => {
    expect(isChoiceAnswer({ questionId: 'q', selectedOptionIds: ['a'] })).toBe(true)
    expect(isChoiceAnswer({ questionId: 'q', selectedOptionIds: [], text: 'hello' })).toBe(true)
    expect(isChoiceAnswer({ questionId: ' ', selectedOptionIds: [] })).toBe(false)
    expect(isChoiceAnswer({ questionId: 'q', selectedOptionIds: [''] })).toBe(false)
    expect(isChoiceAnswer({ questionId: 'q', selectedOptionIds: [], text: 1 })).toBe(false)
  })

  it('accepts exactly one valid answer per question, including optional option notes', () => {
    const answers: ChoiceAnswer[] = [
      { questionId: 'single', selectedOptionIds: ['a'], text: 'note' },
      { questionId: 'multi', selectedOptionIds: ['x', 'y'] },
      { questionId: 'free', selectedOptionIds: [], text: 'details' },
    ]

    expect(validateChoiceAnswers(questions, answers)).toBeNull()
  })

  it.each([
    ['missing answer', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x'] }]],
    ['unknown question', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }, { questionId: 'extra', selectedOptionIds: [] }]],
    ['duplicate question', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'single', selectedOptionIds: ['b'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['option empty text', [{ questionId: 'single', selectedOptionIds: ['a'], text: '   ' }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['unknown option', [{ questionId: 'single', selectedOptionIds: ['bad'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['duplicate selected option', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x', 'x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['single none', [{ questionId: 'single', selectedOptionIds: [] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['single many', [{ questionId: 'single', selectedOptionIds: ['a', 'b'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['multi too few', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: [] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['multi too many', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x', 'y', 'z'] }, { questionId: 'free', selectedOptionIds: [], text: 'details' }]],
    ['freeform option', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: ['x'], text: 'details' }]],
    ['freeform empty', [{ questionId: 'single', selectedOptionIds: ['a'] }, { questionId: 'multi', selectedOptionIds: ['x'] }, { questionId: 'free', selectedOptionIds: [] }]],
  ])('rejects invalid semantic answers: %s', (_name, answers) => {
    expect(validateChoiceAnswers(questions, answers as ChoiceAnswer[])).toEqual(expect.any(String))
  })
})

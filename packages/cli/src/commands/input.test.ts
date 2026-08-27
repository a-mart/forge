import { describe, expect, it } from 'vitest'

import { CliError } from '../output.js'
import { parseAnswersJson } from './input.js'

describe('parseAnswersJson', () => {
  it('accepts protocol-valid option and free-text answers', () => {
    expect(parseAnswersJson('[{"questionId":"q1","selectedOptionIds":["yes"]}]')).toEqual([
      { questionId: 'q1', selectedOptionIds: ['yes'] },
    ])
    expect(parseAnswersJson('[{"questionId":"q2","selectedOptionIds":[],"text":"details"}]')).toEqual([
      { questionId: 'q2', selectedOptionIds: [], text: 'details' },
    ])
  })

  it.each([
    ['blank question ID', '[{"questionId":" ","selectedOptionIds":[]} ]'],
    ['blank option ID', '[{"questionId":"q1","selectedOptionIds":[""]}]'],
    ['non-string text', '[{"questionId":"q1","selectedOptionIds":[],"text":1}]'],
  ])('rejects protocol-invalid answers with %s', (_caseName, input) => {
    expect(() => parseAnswersJson(input)).toThrow(CliError)
    try {
      parseAnswersJson(input)
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_answers' })
    }
  })
})

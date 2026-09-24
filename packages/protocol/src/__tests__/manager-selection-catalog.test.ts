import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MANAGER_POSTURE,
  MANAGER_POSTURES,
  WORK_MODE_DEFINITIONS,
  isManagerPosture,
  isWorkModeId,
} from '../index.js'

describe('manager selection catalog contract', () => {
  it('derives the closed backend posture set and a single product default from one Work Mode table', () => {
    expect(MANAGER_POSTURES).toEqual(WORK_MODE_DEFINITIONS.map((definition) => definition.id))
    expect(WORK_MODE_DEFINITIONS.filter((definition) => definition.productDefault)).toHaveLength(1)
    expect(DEFAULT_MANAGER_POSTURE).toBe(
      WORK_MODE_DEFINITIONS.find((definition) => definition.productDefault)?.id,
    )
  })

  it('keeps transport Work Mode IDs extensible while server-known ManagerPosture stays closed', () => {
    expect(isWorkModeId('review_led')).toBe(true)
    expect(isManagerPosture('review_led')).toBe(false)
    expect(isManagerPosture('adaptive')).toBe(true)
    expect(isWorkModeId('UPPERCASE')).toBe(false)
    expect(isWorkModeId(`a${'x'.repeat(64)}`)).toBe(false)
  })
})

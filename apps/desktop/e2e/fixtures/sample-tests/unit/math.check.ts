import { describe, expect, it } from 'vitest'

describe('math', () => {
  it('adds numbers', () => {
    expect(1 + 2).toBe(3)
  })

  it('fails on purpose', () => {
    expect(2 * 2).toBe(5)
  })

  describe('nested', () => {
    it('multiplies', () => {
      expect(3 * 3).toBe(9)
    })
  })
})

it.skip('is skipped', () => {})

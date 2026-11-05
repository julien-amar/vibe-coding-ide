import { describe, expect, it } from 'vitest'

// Test names that reading the file as text gets wrong (Vitest's static collection):
// the Tests panel must list exactly the tests that run.
describe('names', () => {
  it('keeps \\\\wsl.localhost escapes', () => {
    expect('\\\\x').toHaveLength(3)
  })

  for (const n of [1, 2]) {
    it(`computed title ${n}`, () => {
      expect(n).toBeGreaterThan(0)
    })
  }

  it('is not confused by callbacks', () => {
    expect([1].map((t) => [t])).toEqual([[1]])
  })
})

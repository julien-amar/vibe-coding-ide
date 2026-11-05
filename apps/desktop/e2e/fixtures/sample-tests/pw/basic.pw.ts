import { expect, test } from '@playwright/test'

test.describe('basic', () => {
  test('passes', () => {
    expect('vibe').toContain('vi')
  })

  test('fails on purpose', () => {
    expect([1, 2]).toHaveLength(3)
  })
})

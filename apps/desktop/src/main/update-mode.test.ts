import { describe, expect, it } from 'vitest'
import { updateMode } from './update-mode'

describe('how the app updates itself', () => {
  const on = { packaged: true, disabled: false, macSigned: false }
  it('updates in place on Windows and Linux, and on a signed macOS build', () => {
    expect(updateMode('win32', on)).toBe('auto')
    expect(updateMode('linux', on)).toBe('auto')
    expect(updateMode('darwin', { ...on, macSigned: true })).toBe('auto')
  })
  it('only tells about new versions on an unsigned macOS build (macOS refuses the update)', () => {
    expect(updateMode('darwin', on)).toBe('notify')
  })
  it('is off in development, tests, or when disabled', () => {
    expect(updateMode('win32', { ...on, packaged: false })).toBe('off')
    expect(updateMode('win32', { ...on, disabled: true })).toBe('off')
  })
})

import { describe, expect, it } from 'vitest'
import { formatPairs, joinArgs, parsePairs, skillPath, splitArgs } from './harness-form'

describe('harness editor text forms', () => {
  it('splits and joins arguments, keeping quoted spaces', () => {
    expect(splitArgs('-y @modelcontextprotocol/server-filesystem "C:\\My Docs" \'a "b"\' ""')).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      'C:\\My Docs',
      'a "b"',
      ''
    ])
    expect(splitArgs('   ')).toEqual([])
    const args = ['-y', 'x', 'C:\\My Docs', 'a "b"', '']
    expect(splitArgs(joinArgs(args))).toEqual(args)
  })

  it('reads env (KEY=value) and header (Name: value) lines', () => {
    expect(parsePairs('TOKEN=abc=def\n\nnoseparator\n =x\nDEBUG = 1', '=')).toEqual({ TOKEN: 'abc=def', DEBUG: '1' })
    expect(parsePairs('Authorization: Bearer x:y', ':')).toEqual({ Authorization: 'Bearer x:y' })
    expect(parsePairs('', '=')).toBeUndefined()
    expect(formatPairs({ A: '1', B: '2' }, '=')).toBe('A=1\nB=2')
    expect(formatPairs({ Authorization: 'Bearer x' }, ':')).toBe('Authorization: Bearer x')
  })

  it('stores skill folders inside the project relative to it', () => {
    expect(skillPath('C:\\proj', 'C:\\Proj\\skills\\review')).toBe('skills/review')
    expect(skillPath('/home/me/p', '/home/me/p/.claude/x')).toBe('.claude/x')
    expect(skillPath('/home/me/p', '/opt/skills/x')).toBe('/opt/skills/x')
  })
})

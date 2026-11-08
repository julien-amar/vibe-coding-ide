import { describe, expect, it } from 'vitest'
import { k9sEntries } from './kube'

const launch = (command: string, args: string[]): { command: string; args: string[] } => ({ command, args })

describe('k9s launcher entries', () => {
  it('one entry per context, the current one first and marked', () => {
    const entries = k9sEntries('/usr/bin/k9s', ['dev', 'prod', 'arn:aws:eks:eu-west-1:123456789012:cluster/shop', ''], 'prod', launch)
    expect(entries.map((e) => [e.id, e.name, e.args])).toEqual([
      ['tool:k9s:prod', 'k9s · prod (current)', ['--context', 'prod']],
      ['tool:k9s:dev', 'k9s · dev', ['--context', 'dev']],
      [
        'tool:k9s:arn:aws:eks:eu-west-1:123456789012:cluster/shop',
        'k9s · arn:aws:eks:eu-west-1:123456789012:cluster/shop',
        ['--context', 'arn:aws:eks:eu-west-1:123456789012:cluster/shop']
      ]
    ])
    expect(entries.every((e) => e.kind === 'tool' && e.command === '/usr/bin/k9s')).toBe(true)
  })

  it('leaves out names that are not safe on a command line', () => {
    expect(k9sEntries('k9s', ['ok', '-o', 'a b', 'x&calc', 'ok'], undefined, launch).map((e) => e.id)).toEqual(['tool:k9s:ok'])
  })

  it('without contexts (no kubectl, empty kubeconfig): one entry on k9s’s default', () => {
    expect(k9sEntries('k9s', [], undefined, launch)).toEqual([{ id: 'tool:k9s', name: 'k9s', kind: 'tool', command: 'k9s', args: [], source: 'k9s' }])
  })
})

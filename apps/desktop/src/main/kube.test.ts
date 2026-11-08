import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { k9sEntries, parseWslK9sProbe, WSL_K9S_PROBE, wslK9sEntries } from './kube'

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

describe('k9s inside WSL distributions', () => {
  it('reads the probe: k9s, the current context, the contexts', () => {
    expect(parseWslK9sProbe('k9s=/home/me/.local/bin/k9s\ncurrent=prod\nctx=dev\nctx=prod\n')).toEqual({
      k9s: '/home/me/.local/bin/k9s',
      current: 'prod',
      contexts: ['dev', 'prod']
    })
    expect(parseWslK9sProbe('')).toEqual({ contexts: [] })
    expect(parseWslK9sProbe('k9s=/usr/bin/k9s\ncurrent=\n')).toEqual({ k9s: '/usr/bin/k9s', current: undefined, contexts: [] })
  })

  it('runs k9s in the distribution, through a login shell, on the context', () => {
    const entries = wslK9sEntries('Ubuntu', { k9s: '/usr/bin/k9s', current: 'prod', contexts: ['dev', 'prod'] }, 'wsl.exe')
    expect(entries.map((e) => [e.id, e.name, e.wslDistro])).toEqual([
      ['tool:k9s@Ubuntu:prod', 'k9s · prod (current) (Ubuntu)', 'Ubuntu'],
      ['tool:k9s@Ubuntu:dev', 'k9s · dev (Ubuntu)', 'Ubuntu']
    ])
    expect(entries[1]).toMatchObject({ command: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '~', '--exec', 'bash', '-lic', "exec k9s '--context' 'dev'"] })
    expect(wslK9sEntries('Ubuntu', { k9s: '/usr/bin/k9s', contexts: [] }, 'wsl.exe')[0]).toMatchObject({
      id: 'tool:k9s@Ubuntu',
      args: ['-d', 'Ubuntu', '--cd', '~', '--exec', 'bash', '-lic', 'exec k9s']
    })
    expect(wslK9sEntries('Ubuntu', { contexts: ['dev'] }, 'wsl.exe')).toEqual([])
  })

  // The probe in a real bash, with stand-in k9s and kubectl (Windows: the bash on PATH may be WSL's).
  it.skipIf(process.platform === 'win32')('the probe script finds k9s and the contexts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vci-k9s-'))
    try {
      writeFileSync(join(dir, 'k9s'), '#!/bin/sh\n', { mode: 0o755 })
      writeFileSync(
        join(dir, 'kubectl'),
        '#!/bin/sh\ncase "$*" in "config current-context") echo prod ;; "config get-contexts -o name") printf "dev\nprod\n" ;; esac\n',
        { mode: 0o755 }
      )
      const out = execFileSync('bash', ['-c', WSL_K9S_PROBE], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } })
      expect(parseWslK9sProbe(out)).toEqual({ k9s: join(dir, 'k9s'), current: 'prod', contexts: ['dev', 'prod'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

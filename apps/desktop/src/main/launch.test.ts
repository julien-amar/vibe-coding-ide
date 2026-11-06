import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { LayoutNode, Profile, TabSnapshot } from '@shared/types'
import { startIn, withExtra } from './launch'
import { sanitizeTab } from './layout-sanitize'

const dir = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-launch-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const wslAgent: Profile = {
  id: 'wslagent:Ubuntu:claude',
  name: 'Claude Code (Ubuntu)',
  kind: 'agent',
  command: 'wsl.exe',
  args: ['-d', 'Ubuntu', '--cd', '~', '--exec', 'bash', '-lic', 'exec claude'],
  wslDistro: 'Ubuntu'
}

describe('where a panel process starts', () => {
  it('gives local processes an existing folder as cwd', () => {
    const shell: Profile = { id: 'pwsh', name: 'PowerShell', kind: 'shell', command: 'pwsh', args: [] }
    expect(startIn(shell, dir)).toEqual({ launch: shell, cwd: dir })
    expect(startIn(shell, join(dir, 'missing'))).toEqual({ launch: shell, cwd: undefined })
  })

  it('starts WSL processes in the Linux folder of a project of the same distribution', () => {
    expect(startIn(wslAgent, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj').launch.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/proj'])
    expect(startIn(wslAgent, '/srv/app').launch.args[3]).toBe('/srv/app')
    // Another distribution's folder, or a Windows folder: the profile's own (~).
    expect(startIn(wslAgent, '\\\\wsl.localhost\\Debian\\home\\me').launch).toBe(wslAgent)
  })
})

describe('an agent launch with its settings added', () => {
  it('passes a WSL agent its arguments through "$@" and its environment through WSLENV', () => {
    const r = withExtra(wslAgent, { args: ['--mcp-config', '/mnt/c/x/mcp.json'], env: { OPENCODE_CONFIG: '/mnt/c/x' } })
    expect(r.args.slice(-4)).toEqual(['exec claude "$@"', 'claude', '--mcp-config', '/mnt/c/x/mcp.json'])
    expect(r.env?.WSLENV?.split(':')).toContain('OPENCODE_CONFIG')
    expect(r.env?.OPENCODE_CONFIG).toBe('/mnt/c/x')
  })

  it('appends arguments for agents on this machine', () => {
    const local: Profile = { id: 'agent:claude', name: 'Claude Code', kind: 'agent', command: '/usr/bin/claude', args: [] }
    expect(withExtra(local, { args: ['--x'], env: {} }).args).toEqual(['--x'])
  })
})

describe('tabs from a renderer or the layout file', () => {
  it('keeps known fields and agent settings, drops the rest', () => {
    const layout = {
      kind: 'split',
      dir: 'diagonal',
      sizes: [-1],
      children: [
        { kind: 'pane', id: 'a', type: 'agent', harness: { instructions: 'Use pnpm.', mcpServers: [{ name: '' }] }, extra: 1 },
        { kind: 'pane', id: 'b', type: 'browser' },
        { kind: 'pane', id: 'c', type: 'terminal', harness: { instructions: 'not for terminals' } }
      ]
    } as unknown as LayoutNode
    const tab = sanitizeTab({ kind: 'nope', autoTitle: 'x', project: { root: '/p', name: 'p', layout } } as unknown as TabSnapshot)
    expect(tab.kind).toBe('shell')
    expect(tab.project?.layout).toEqual({
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'pane', id: 'a', type: 'agent', profileId: undefined, sessionId: undefined, collapsed: undefined, harness: { mcpServers: [], skills: [], instructions: 'Use pnpm.', strictMcp: undefined, strictSkills: undefined } },
        { kind: 'pane', id: 'c', type: 'terminal', profileId: undefined, sessionId: undefined, collapsed: undefined, harness: undefined }
      ]
    })
  })
})

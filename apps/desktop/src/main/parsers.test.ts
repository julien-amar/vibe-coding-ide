import { describe, expect, it } from 'vitest'
import { parseNameStatus, parseStatus, worktreeDir } from './git'
import { countWingetUpgrades } from './package-updates'
import { lastReportedCwd } from './shell-integration'

describe('parseStatus (git status --porcelain=v1 -z --branch)', () => {
  it('parses branch, upstream, ahead/behind and files', () => {
    const raw = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'M  staged.txt', '?? new file.txt', 'R  new.ts', 'old.ts', ''].join('\0')
    const s = parseStatus(raw)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(s.files).toEqual([
      { path: 'src/a.ts', index: ' ', worktree: 'M' },
      { path: 'staged.txt', index: 'M', worktree: ' ' },
      { path: 'new file.txt', index: '?', worktree: '?' },
      { path: 'new.ts', index: 'R', worktree: ' ', origPath: 'old.ts' }
    ])
  })

  it('handles unpublished branches, empty repositories and detached HEAD', () => {
    expect(parseStatus('## feature/x\0')).toMatchObject({ branch: 'feature/x', upstream: undefined, ahead: 0, behind: 0 })
    expect(parseStatus('## No commits yet on main\0').branch).toBe('main')
    expect(parseStatus('## HEAD (no branch)\0').branch).toBeUndefined()
    expect(parseStatus('## main...origin/main [gone]\0')).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0 })
  })
})

describe('parseNameStatus (--name-status -z)', () => {
  it('parses modifications, additions, deletions and renames', () => {
    const raw = ['M', 'a.txt', 'A', 'src/b.ts', 'D', 'gone.md', 'R087', 'old/name.ts', 'new/name.ts', ''].join('\0')
    expect(parseNameStatus(raw)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'D', path: 'gone.md' },
      { status: 'R', origPath: 'old/name.ts', path: 'new/name.ts' }
    ])
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('worktreeDir', () => {
  it('puts feature worktrees next to the repository', () => {
    expect(worktreeDir('/home/me/repo', 'login page')).toBe('/home/me/repo-login-page')
    expect(worktreeDir(String.raw`C:\src\repo\\`, 'api')).toBe(String.raw`C:\src\repo-api`)
  })
})

describe('countWingetUpgrades', () => {
  const table = (rows: string[], extra = ''): string =>
    [
      '   - \r   \\ \r', // progress spinner redraws
      'Name                 Id                Version  Available Source',
      '-----------------------------------------------------------------',
      ...rows,
      `${rows.length} upgrades available.`,
      extra
    ].join('\r\n')

  it('counts the rows of the upgrade table (CRLF output, spinner noise)', () => {
    expect(countWingetUpgrades(table(['7-Zip   7zip.7zip  24.09  26.05  winget', 'Node.js OpenJS.NodeJS 24.1 26.1 winget']))).toBe(2)
  })

  it('does not count the second table of packages that need explicit targeting', () => {
    const extra = ['', 'The following packages have an upgrade available, but require explicit targeting for upgrade:', 'Name Id Version Available', '----------------------------', 'Pinned  x.y  1 2'].join('\r\n')
    expect(countWingetUpgrades(table(['A a 1 2 winget'], extra))).toBe(1)
  })

  it('returns 0 without a table', () => {
    expect(countWingetUpgrades('No installed package found matching input criteria.\r\n')).toBe(0)
    expect(countWingetUpgrades('')).toBe(0)
  })
})

describe('lastReportedCwd (shell integration)', () => {
  it('reads OSC 9;9 (PowerShell, cmd, Git Bash) and OSC 7 (bash in WSL)', () => {
    expect(lastReportedCwd('PS> \x1b]9;9;"C:\\Windows\\System32"\x1b\\')).toBe('C:\\Windows\\System32')
    expect(lastReportedCwd('\x1b]9;9;C:\\Program Files\x1b\\C:\\Program Files>')).toBe('C:\\Program Files')
    expect(lastReportedCwd('\x1b]7;file://host/home/me/my%20dir\x07$ ')).toBe('/home/me/my dir')
  })

  it('normalises Git Bash forward slashes and keeps the last report', () => {
    expect(lastReportedCwd('\x1b]9;9;C:/Users/Public\x1b\\')).toBe('C:\\Users\\Public')
    expect(lastReportedCwd('\x1b]7;file://h/a\x07 ... \x1b]7;file://h/b\x07')).toBe('/b')
    expect(lastReportedCwd('no sequences here')).toBeUndefined()
  })
})

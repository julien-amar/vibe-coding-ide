import { describe, expect, it } from 'vitest'
import type { ComposeProject, ContainerInfo } from '@shared/types'
import { isActive, runningServices } from './lists'
import {
  bottomTabs,
  composeProjectName,
  formatBytes,
  keepTail,
  matches,
  parseHumanSize,
  shortId,
  splitList,
  timeOf,
  viewAfterSelect,
  type Selection
} from './model'
import { envList, envRows, validateEnv, validateMounts, validatePorts } from './spec-rows'
import { nextSort, sortRows, type Column } from './table'
import { pairs, volumeSettings } from './volume-settings'

const container: Selection = { engine: 'docker', target: 'container', id: 'c1', name: 'web', running: true }

describe('bottom section', () => {
  it('offers the views of what is selected', () => {
    expect(bottomTabs(undefined, false)).toEqual([])
    expect(bottomTabs(undefined, true)).toEqual(['output'])
    expect(bottomTabs(container, false)).toEqual(['logs', 'terminal', 'files', 'mounts', 'ports', 'env', 'stats', 'inspect'])
    // Terminal and files need a running container.
    expect(bottomTabs({ ...container, running: false }, true)).toEqual(['logs', 'mounts', 'ports', 'env', 'stats', 'inspect', 'output'])
    expect(bottomTabs({ engine: 'wslc', target: 'image', id: 'i', name: 'nginx' }, false)).toEqual(['inspect'])
  })

  it('keeps the current view when another container is selected', () => {
    expect(viewAfterSelect(container, 'stats')).toBe('stats')
    expect(viewAfterSelect(container, 'output')).toBe('logs')
    expect(viewAfterSelect(container, undefined)).toBe('logs')
    expect(viewAfterSelect({ ...container, target: 'volume' }, 'stats')).toBe('inspect')
  })
})

describe('formatting and parsing', () => {
  it('sizes, ids, times', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(23_400_000)).toBe('23 MB')
    expect(formatBytes(1_073_741_824)).toBe('1.1 GB')
    expect(formatBytes('10.1kB')).toBe('10.1kB')
    expect(parseHumanSize('10.1kB')).toBeCloseTo(10_100)
    expect(parseHumanSize('1.5 GB')).toBe(1_500_000_000)
    expect(parseHumanSize('512B')).toBe(512)
    expect(parseHumanSize('n/a')).toBe(0)
    expect(shortId('sha256:aaaa1111bbbbcccc')).toBe('aaaa1111bbbb')
    expect(timeOf(1700000000)).toBe(1700000000)
    expect(timeOf('2023-11-14T22:13:20Z')).toBe(1700000000)
    expect(timeOf('not a date')).toBe(0)
    expect(timeOf(undefined)).toBe(0)
  })

  it('filters, names, lists', () => {
    expect(matches('', 'anything')).toBe(true)
    expect(matches('web', 'shop-WEB-1'.toLowerCase())).toBe(true)
    expect(matches('db', 'web', undefined)).toBe(false)
    expect(composeProjectName('C:\\work\\My Shop\\')).toBe('myshop')
    expect(composeProjectName('/srv/api_v2')).toBe('api_v2')
    expect(composeProjectName('/')).toBe('app')
    expect(splitList(' 8080:80, ,443:443 ', /,/)).toEqual(['8080:80', '443:443'])
    expect(splitList('A=1\r\n\nB=2', /\r?\n/)).toEqual(['A=1', 'B=2'])
    expect(splitList(undefined, /,/)).toEqual([])
    expect(keepTail('abc')).toBe('abc')
    expect(keepTail('x'.repeat(400_010))).toHaveLength(400_000)
  })
})

describe('tables', () => {
  const columns: Column<{ name: string; size: number }>[] = [
    { key: 'name', label: 'Name', width: '1fr', cell: (x) => x.name, sort: (x) => x.name },
    { key: 'size', label: 'Size', width: '1fr', cell: (x) => x.size, sort: (x) => x.size },
    { key: 'plain', label: 'Plain', width: '1fr', cell: () => '' }
  ]
  const rows = [
    { name: 'img10', size: 3 },
    { name: 'img2', size: 20 },
    { name: 'img1', size: 100 }
  ]

  it('sorts: text with numbers in natural order, numbers as numbers, unsortable columns not', () => {
    expect(sortRows(rows, columns, { key: 'name', desc: false }).map((r) => r.name)).toEqual(['img1', 'img2', 'img10'])
    expect(sortRows(rows, columns, { key: 'size', desc: true }).map((r) => r.size)).toEqual([100, 20, 3])
    expect(sortRows(rows, columns, { key: 'plain', desc: false })).toBe(rows)
    expect(sortRows(rows, columns, undefined)).toBe(rows)
  })

  it('a header click: ascending, descending, unsorted; another column starts ascending', () => {
    expect(nextSort(undefined, 'name')).toEqual({ key: 'name', desc: false })
    expect(nextSort({ key: 'name', desc: false }, 'name')).toEqual({ key: 'name', desc: true })
    expect(nextSort({ key: 'name', desc: true }, 'name')).toBeUndefined()
    expect(nextSort({ key: 'name', desc: true }, 'size')).toEqual({ key: 'size', desc: false })
  })

  it('stopped containers and running services', () => {
    const withState = (state: string): ContainerInfo => ({ id: state, name: state, image: 'x', state, status: '', ports: [] })
    expect(['running', 'paused', 'restarting', 'exited', 'created', 'dead'].filter((s) => isActive(withState(s)))).toEqual(['running', 'paused', 'restarting'])
    const project: ComposeProject = {
      name: 'shop',
      configFiles: [],
      services: [
        { name: 'web', state: 'running', container: 'shop-web-1' },
        { name: 'db', state: 'exited', container: 'shop-db-1' }
      ]
    }
    expect(runningServices(project)).toBe(1)
  })
})

describe('container settings editors', () => {
  it('environment: rows ↔ KEY=VALUE, names checked', () => {
    expect(envRows(['A=1', 'URL=a=b', 'EMPTY'])).toEqual([
      { key: 'A', value: '1' },
      { key: 'URL', value: 'a=b' },
      { key: 'EMPTY', value: '' }
    ])
    expect(
      envList([
        { key: ' A ', value: '1' },
        { key: '', value: 'dropped' }
      ])
    ).toEqual(['A=1'])
    expect(validateEnv([{ key: 'A', value: '1' }])).toBeUndefined()
    expect(validateEnv([{ key: 'BAD KEY', value: '1' }])).toBe('Invalid name: BAD KEY')
    expect(
      validateEnv([
        { key: 'A', value: '1' },
        { key: 'A', value: '2' }
      ])
    ).toBe('A is set twice.')
  })

  it('mounts: absolute paths, a source unless tmpfs, no path twice', () => {
    expect(validateMounts([{ type: 'tmpfs', source: '', target: '/run', readOnly: false }])).toBeUndefined()
    expect(validateMounts([{ type: 'volume', source: 'v', target: 'data', readOnly: false }])).toBe('The path in the container must start with "/": data.')
    expect(validateMounts([{ type: 'bind', source: ' ', target: '/a', readOnly: false }])).toBe('A host folder is needed for /a.')
    expect(
      validateMounts([
        { type: 'volume', source: 'v', target: '/a', readOnly: false },
        { type: 'volume', source: 'w', target: '/a', readOnly: true }
      ])
    ).toBe('/a is mounted twice.')
  })

  it('ports: a container port, host ports or ranges, no host port twice (IPv6 host IPs too)', () => {
    const p = (port: number, hostPort = '', hostIp = '', protocol = 'tcp') => ({ container: port, hostPort, hostIp, protocol })
    expect(validatePorts([p(80, '8080'), p(443, '8000-8010'), p(53, '53', '', 'udp'), p(53, '53')])).toBeUndefined()
    expect(validatePorts([p(0)])).toBe('Each port needs a container port (1-65535).')
    expect(validatePorts([p(80, 'http')])).toBe('Invalid host port: http')
    expect(validatePorts([p(80, '8080', '::1'), p(81, '8080', '::1')])).toBe('Host port 8080/tcp is used twice.')
    expect(validatePorts([p(80, '8080', '::1'), p(81, '8080', '127.0.0.1')])).toBeUndefined()
  })
})

describe('new volumes', () => {
  it('reads KEY=VALUE lines', () => {
    expect(pairs('a=1\n\n b = 2 ')).toEqual({ map: { a: '1', b: '2' } })
    expect(pairs('novalue').error).toBe('"novalue" is not KEY=VALUE')
  })

  it('builds the driver options of each type', () => {
    expect(volumeSettings('local', {})).toEqual({ options: {} })
    expect(volumeSettings('nfs', { server: '10.0.0.5', path: '/export', mount: 'rw' })).toEqual({
      driver: 'local',
      options: { type: 'nfs', o: 'addr=10.0.0.5,rw', device: ':/export' }
    })
    expect(volumeSettings('nfs', { server: '10.0.0.5' }).error).toMatch(/needed/)
    expect(volumeSettings('cifs', { share: '//nas/data' })).toEqual({ driver: 'local', options: { type: 'cifs', device: '//nas/data' } })
    expect(volumeSettings('bind', { path: '/srv/data' })).toEqual({ driver: 'local', options: { type: 'none', o: 'bind', device: '/srv/data' } })
    expect(volumeSettings('tmpfs', { size: '256m' })).toEqual({ driver: 'local', options: { type: 'tmpfs', device: 'tmpfs', o: 'size=256m' } })
    expect(volumeSettings('custom', { driver: 'rexray/ebs', options: 'size=10' })).toEqual({ driver: 'rexray/ebs', options: { size: '10' } })
    expect(volumeSettings('vhd', {})).toEqual({ driver: 'vhd', options: {} })
    expect(volumeSettings('local', { options: 'oops' }).error).toMatch(/KEY=VALUE/)
  })
})

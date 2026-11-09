import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { discoverTests } from './test-runner'

// Adapters with set listings (detection stays real: a go.mod, a Cargo.toml, a .NET test project).
vi.mock('./tests/go', async (orig) => {
  const m = await orig<typeof import('./tests/go')>()
  return { ...m, goAdapter: { ...m.goAdapter, list: async () => ({ tests: [] }) } }
})
vi.mock('./tests/cargo', async (orig) => {
  const m = await orig<typeof import('./tests/cargo')>()
  return {
    ...m,
    cargoAdapter: { ...m.cargoAdapter, list: async () => ({ tests: [{ id: 'adds', file: 'src/lib.rs', suite: [], name: 'adds' }] }) }
  }
})
vi.mock('./tests/dotnet', async (orig) => {
  const m = await orig<typeof import('./tests/dotnet')>()
  return { ...m, dotnetAdapter: { ...m.dotnetAdapter, list: async () => ({ tests: [], error: 'error CS1002: ; expected' }) } }
})

describe('test discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-discover-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const w = (f: string, s = ''): void => {
    mkdirSync(join(root, f, '..'), { recursive: true })
    writeFileSync(join(root, f), s)
  }

  it('leaves out projects that list no test, keeping those with tests or a listing error', async () => {
    w('empty-go/go.mod', 'module example.com/empty\n')
    w('crate/Cargo.toml', '[package]\nname = "crate"\n')
    w('Broken.Tests/Broken.Tests.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>')

    const projects = await discoverTests(root)
    expect(projects.map((p) => p.id).sort()).toEqual(['cargo:crate', 'dotnet:Broken.Tests'])
    expect(projects.find((p) => p.framework === 'cargo')?.tests).toHaveLength(1)
    expect(projects.find((p) => p.framework === 'dotnet')?.error).toContain('CS1002')
  })
})

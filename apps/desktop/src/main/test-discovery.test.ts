import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { TestProject } from '@shared/types'
import { discoverTests } from './test-runner'
import { solutionOf } from './tests/dotnet'

/** .NET listings of the test: which project, built or not, and how many at once. */
const dotnet = { calls: [] as { project: string; prebuilt: boolean }[], active: 0, maxUnbuiltAtOnce: 0 }

// Adapters with set listings (detection stays real: a go.mod, a Cargo.toml, .NET test projects).
vi.mock('./tests/go', async (orig) => {
  const m = await orig<typeof import('./tests/go')>()
  return { ...m, goAdapter: { ...m.goAdapter, list: async () => ({ tests: [] }) } }
})
vi.mock('./tests/cargo', async (orig) => {
  const m = await orig<typeof import('./tests/cargo')>()
  const adds = { id: 'adds', file: 'src/lib.rs', suite: [], name: 'adds' }
  // Listed twice (as .NET lists its tests once per target framework).
  return { ...m, cargoAdapter: { ...m.cargoAdapter, list: async () => ({ tests: [adds, { ...adds }] }) } }
})
vi.mock('./tests/dotnet', async (orig) => {
  const m = await orig<typeof import('./tests/dotnet')>()
  return {
    ...m,
    // The projects of Platform.sln build (the solution is not really built).
    buildDotnetSolutions: async (_root: string, dirs: string[]) => new Set(dirs.filter((d) => basename(d).startsWith('Platform.'))),
    dotnetAdapter: {
      ...m.dotnetAdapter,
      list: async (dir: string, _work: unknown, opts?: { prebuilt?: boolean }) => {
        const project = basename(dir)
        dotnet.calls.push({ project, prebuilt: !!opts?.prebuilt })
        if (project === 'Broken.Tests') return { tests: [], error: 'error CS1002: ; expected' }
        if (!opts?.prebuilt) dotnet.maxUnbuiltAtOnce = Math.max(dotnet.maxUnbuiltAtOnce, ++dotnet.active)
        await new Promise((r) => setTimeout(r, 30))
        if (!opts?.prebuilt) dotnet.active--
        return { tests: [{ id: `${project}::T`, file: project, suite: [], name: 'T' }], projectFile: `${project}.csproj` }
      }
    }
  }
})

const TEST_PROJECT = '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>'

describe('test discovery', () => {
  const base = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-discover-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const writer =
    (root: string) =>
    (f: string, s = ''): void => {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), s)
    }

  it('leaves out projects that list no test, keeping those with tests or a listing error; a test listed twice is one test', async () => {
    const root = join(base, 'mixed')
    const w = writer(root)
    w('empty-go/go.mod', 'module example.com/empty\n')
    w('crate/Cargo.toml', '[package]\nname = "crate"\n')
    w('Broken.Tests/Broken.Tests.csproj', TEST_PROJECT)

    const projects = await discoverTests(root)
    expect(projects.map((p) => p.id).sort()).toEqual(['cargo:crate', 'dotnet:Broken.Tests'])
    expect(projects.find((p) => p.framework === 'cargo')?.tests).toHaveLength(1)
    expect(projects.find((p) => p.framework === 'dotnet')?.error).toContain('CS1002')
  })

  it('reports each project as soon as it is listed, with its place in the panel (projects without tests: not reported)', async () => {
    const root = join(base, 'streamed')
    const w = writer(root)
    w('a-crate/Cargo.toml', '[package]\nname = "a"\n')
    w('b-empty/go.mod', 'module example.com/empty\n')
    w('c-net/C.Tests/C.Tests.csproj', TEST_PROJECT)
    const seen: { id: string; index: number }[] = []
    const all = await discoverTests(root, (p: TestProject, index: number) => seen.push({ id: p.id, index }))
    // The Rust crate (listed at once) comes before the .NET project (listed after its delay).
    expect(seen).toEqual([
      { id: 'cargo:a-crate', index: 0 },
      { id: 'dotnet:c-net/C.Tests', index: 2 }
    ])
    expect(all.map((p) => p.id)).toEqual(['cargo:a-crate', 'dotnet:c-net/C.Tests'])
  })

  it('.NET: projects of a built solution are listed without a build; the others one at a time', async () => {
    const root = join(base, 'dotnet')
    const w = writer(root)
    for (const p of ['Platform.Api.Tests', 'Platform.Core.Tests', 'Tool.A.Tests', 'Tool.B.Tests', 'Tool.C.Tests']) w(`${p}/${p}.csproj`, TEST_PROJECT)
    dotnet.calls = []
    dotnet.maxUnbuiltAtOnce = 0

    const projects = await discoverTests(root)
    expect(projects).toHaveLength(5)
    expect(
      dotnet.calls
        .filter((c) => c.prebuilt)
        .map((c) => c.project)
        .sort()
    ).toEqual(['Platform.Api.Tests', 'Platform.Core.Tests'])
    expect(dotnet.calls.filter((c) => !c.prebuilt)).toHaveLength(3)
    // Never two builds of test projects at the same time.
    expect(dotnet.maxUnbuiltAtOnce).toBe(1)
  })

  it('.NET: a test project’s solution is the nearest one, up to the project folder, that lists it', () => {
    const root = join(base, 'solutions')
    const w = writer(root)
    w('Platform.sln', 'Project("{X}") = "Api.Tests", "tests\\Api.Tests\\Api.Tests.csproj", "{Y}"\n')
    w('Other.sln', 'Project("{X}") = "Other", "src\\Other\\Other.csproj", "{Y}"\n')
    w('tests/Api.Tests/Api.Tests.csproj', TEST_PROJECT)
    // A nearer solution (.slnx) that lists it wins.
    w('tools/Tools.slnx', '<Solution><Project Path="Tool.Tests/Tool.Tests.csproj" /></Solution>\n')
    w('tools/Tool.Tests/Tool.Tests.csproj', TEST_PROJECT)
    // Listed by no solution.
    w('lonely/Lonely.Tests/Lonely.Tests.csproj', TEST_PROJECT)

    expect(solutionOf(root, join(root, 'tests', 'Api.Tests'), 'Api.Tests.csproj')).toBe(join(root, 'Platform.sln'))
    expect(solutionOf(root, join(root, 'tools', 'Tool.Tests'), 'Tool.Tests.csproj')).toBe(join(root, 'tools', 'Tools.slnx'))
    expect(solutionOf(root, join(root, 'lonely', 'Lonely.Tests'), 'Lonely.Tests.csproj')).toBeUndefined()
    // Not looked for above the project folder.
    expect(solutionOf(join(root, 'tests'), join(root, 'tests', 'Api.Tests'), 'Api.Tests.csproj')).toBeUndefined()
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import type { TestResult } from '@shared/types'
import { which } from '../profiles'
import { discoverTests, runTests } from '../test-runner'
import { parseCargoArtifacts, parseCargoList, parseCargoOutput } from './cargo'
import { parseJUnitXml } from './core'
import { dotnetCase, dotnetFilter, parseDotnetLine, parseDotnetList, parseTrx } from './dotnet'
import { goRunArgs, packageDir, parseGoList } from './go'
import { jvmFilter, junitId, mergeJUnit, parseJavaTests, surefirePatterns, surefireRuns } from './jvm'

const FIXTURE = resolve(__dirname, '../../../e2e/fixtures/polyglot-tests')

describe('Go', () => {
  it('reads `go test -list . -json` and builds -run patterns per level', () => {
    const out = [
      '{"Action":"start","Package":"example.com/m/mathx"}',
      '{"Action":"output","Package":"example.com/m/mathx","Output":"TestAdd\\n"}',
      '{"Action":"output","Package":"example.com/m/mathx","Output":"BenchmarkAdd\\n"}',
      '{"Action":"output","Package":"example.com/m","Output":"ExampleHello\\n"}',
      '{"Action":"output","Package":"example.com/m/mathx","Output":"ok  \\texample.com/m/mathx\\t0.1s\\n"}'
    ].join('\n')
    expect(parseGoList('example.com/m', out)).toEqual([
      { pkgDir: 'mathx', name: 'TestAdd' },
      { pkgDir: '.', name: 'ExampleHello' }
    ])
    expect(packageDir('example.com/m', 'other.org/x')).toBe('other.org/x')
    expect(goRunArgs({ projectId: 'x' })).toEqual(['test', '-json', '-count=1', './...'])
    expect(goRunArgs({ projectId: 'x', file: 'mathx', titlePath: ['TestTable', 'small (1)'] })).toEqual([
      'test',
      '-json',
      '-count=1',
      './mathx',
      '-run',
      '^TestTable$/^small \\(1\\)$'
    ])
  })
})

describe('Rust', () => {
  it('reads cargo artifacts, test lists and libtest output', () => {
    const json = [
      '{"reason":"compiler-artifact","profile":{"test":true},"executable":"/p/target/debug/deps/x-1","target":{"src_path":"/p/src/lib.rs"},"manifest_path":"/p/Cargo.toml"}',
      '{"reason":"compiler-artifact","profile":{"test":false},"executable":null,"target":{"src_path":"/p/src/lib.rs"}}',
      '{"reason":"compiler-message","message":{"level":"error","rendered":"error[E0308]: mismatched types"}}'
    ].join('\n')
    const { artifacts, diagnostics } = parseCargoArtifacts(json)
    expect(artifacts).toEqual([{ src: '/p/src/lib.rs', exe: '/p/target/debug/deps/x-1', manifestDir: '/p' }])
    expect(diagnostics).toEqual(['error[E0308]: mismatched types'])
    expect(parseCargoList('tests::adds: test\ntests::bench: benchmark\n\nadds_from_outside: test\n')).toEqual(['tests::adds', 'adds_from_outside'])
    const out = [
      'running 3 tests',
      'test tests::skipped ... ignored, not yet',
      'test tests::adds ... ok',
      'test tests::fails ... FAILED',
      '',
      'failures:',
      '',
      '---- tests::fails stdout ----',
      "thread 'tests::fails' panicked at src/lib.rs:18:9:",
      'assertion failed',
      '',
      'failures:',
      '    tests::fails',
      '',
      'test result: FAILED. 1 passed; 1 failed; 1 ignored'
    ].join('\n')
    expect(parseCargoOutput(out)).toEqual([
      { path: 'tests::skipped', status: 'skipped' },
      { path: 'tests::adds', status: 'passed' },
      { path: 'tests::fails', status: 'failed', message: "thread 'tests::fails' panicked at src/lib.rs:18:9:\nassertion failed" }
    ])
  })
})

describe('.NET', () => {
  it('reads test names, console results, TRX reports and builds filters', () => {
    expect(dotnetCase('Ns.MathTests.AddsPairs(a: 1, b: "x.y")')).toEqual({
      id: 'Ns.MathTests::AddsPairs(a: 1, b: "x.y")',
      file: 'Ns.MathTests',
      suite: [],
      name: 'AddsPairs(a: 1, b: "x.y")'
    })
    expect(dotnetCase('Ns.MathTests+Nested.Works').file).toBe('Ns.MathTests+Nested')
    const list = 'Test run for x.dll\nThe following Tests are available:\n    Ns.A.One\n    Ns.A.Two(x: 1)\nOther output\n'
    expect(parseDotnetList(list)).toEqual(['Ns.A.One', 'Ns.A.Two(x: 1)'])
    expect(parseDotnetLine('  Passed Ns.A.One [93 ms]')).toEqual({ id: 'Ns.A::One', status: 'passed', duration: 93 })
    expect(parseDotnetLine('  Failed Ns.A.Two(x: 1) [< 1 ms]')).toEqual({ id: 'Ns.A::Two(x: 1)', status: 'failed', duration: 0 })
    expect(parseDotnetLine('  Skipped Ns.A.Three [1 s]')?.duration).toBe(1000)
    expect(parseDotnetLine('Passed!  - Failed: 0, Passed: 2')).toBeUndefined()

    const trx = `<TestRun><Results>
      <UnitTestResult testId="1" testName="Ns.A.One" outcome="Passed" duration="00:00:00.0930000" />
      <UnitTestResult testId="2" testName="Two" outcome="Failed" duration="00:00:01.5000000"><Output><ErrorInfo>
        <Message>Assert.Equal() Failure: 5 &lt;&gt; 4</Message><StackTrace>   at Ns.A.Two() in C:\\x\\A.cs:line 11</StackTrace>
      </ErrorInfo></Output></UnitTestResult>
      <UnitTestResult testId="3" testName="Ns.A.Three" outcome="NotExecuted" />
    </Results><TestDefinitions>
      <UnitTest name="Two" id="2"><TestMethod className="Ns.A" name="Two" /></UnitTest>
    </TestDefinitions></TestRun>`
    const results = parseTrx(trx)
    expect(results.map((r) => `${r.id}=${r.status}`)).toEqual(['Ns.A::One=passed', 'Ns.A::Two=failed', 'Ns.A::Three=skipped'])
    expect(results[0].duration).toBeCloseTo(93)
    expect(results[1].message).toBe('Assert.Equal() Failure: 5 <> 4\nat Ns.A.Two() in C:\\x\\A.cs:line 11')

    expect(dotnetFilter({ projectId: 'x' })).toEqual([])
    expect(dotnetFilter({ projectId: 'x', file: 'Ns.A' })).toEqual(['--filter', 'FullyQualifiedName~Ns.A.'])
    expect(dotnetFilter({ projectId: 'x', file: 'Ns.A', titlePath: ['Two(x: 1)'] })).toEqual(['--filter', 'FullyQualifiedName=Ns.A.Two'])
  })
})

describe('Java (Maven / Gradle)', () => {
  it('finds test methods in sources: nested classes, parameterized tests, comments and strings', () => {
    const src = readFileSync(join(FIXTURE, 'java/src/test/java/sample/MathTest.java'), 'utf8')
    expect(parseJavaTests(src).map((t) => `${t.cls}#${t.method}@${t.line}`)).toEqual([
      'sample.MathTest#adds@15',
      'sample.MathTest#failsOnPurpose@20',
      'sample.MathTest#skipped@26',
      'sample.MathTest#addsPairs@30',
      'sample.MathTest$Inner#works@37'
    ])
    const tricky = [
      'package a.b;',
      '/* @Test void notATest() {} */',
      'public class T {',
      '  // @Test void commented() {}',
      '  @Test @DisplayName("with (parens) {braces}")',
      '  public void real() throws Exception {',
      '    String s = "@Test void inString() {";',
      '  }',
      '  @org.junit.Test',
      '  public void junit4() {}',
      '}'
    ].join('\n')
    expect(parseJavaTests(tricky).map((t) => `${t.cls}#${t.method}`)).toEqual(['a.b.T#real', 'a.b.T#junit4'])
  })

  it('reads JUnit XML (merging parameterized cases) and builds filters', () => {
    const xml = `<testsuite>
      <testcase name="adds()" classname="sample.MathTest" time="0.01"/>
      <testcase name="addsPairs(int, int)[1]" classname="sample.MathTest" time="0.002"/>
      <testcase name="addsPairs(int, int)[2]" classname="sample.MathTest" time="0.003">
        <failure message="expected: &lt;3&gt;" type="AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <3>
	at sample.MathTest.addsPairs(MathTest.java:31)]]></failure>
      </testcase>
      <testcase name="skipped()" classname="sample.MathTest"><skipped message="not yet"/></testcase>
      <testcase name="works()" classname="sample.MathTest$Inner" time="0"/>
    </testsuite>`
    const cases = parseJUnitXml(xml)
    expect(junitId(cases[1])).toBe('sample.MathTest::addsPairs')
    const merged = mergeJUnit(cases)
    expect(merged.map((r) => `${r.id}=${r.status}`)).toEqual([
      'sample.MathTest::adds=passed',
      'sample.MathTest::addsPairs=failed',
      'sample.MathTest::skipped=skipped',
      'sample.MathTest$Inner::works=passed'
    ])
    expect(merged[1].duration).toBeCloseTo(5)
    expect(merged[1].message).toContain('at sample.MathTest.addsPairs(MathTest.java:31)')
    // Gradle names parameterized / repeated cases by display name only: they go to the class's only
    // multi-case test (known from the sources); other unknown names become rows of their own.
    const gradle = parseJUnitXml(`<testsuite>
      <testcase name="adds()" classname="sample.MathTest" time="0.001"/>
      <testcase name="[1] 1, 1" classname="sample.MathTest" time="0.018"/>
      <testcase name="[2] 1000, 2000" classname="sample.MathTest" time="0.001"/>
      <testcase name="Custom display name" classname="sample.Other" time="0"/>
    </testsuite>`)
    const known = [
      { cls: 'sample.MathTest', method: 'adds', line: 1 },
      { cls: 'sample.MathTest', method: 'addsPairs', line: 2, multi: true },
      { cls: 'sample.Other', method: 'a', line: 1, multi: true },
      { cls: 'sample.Other', method: 'b', line: 2, multi: true }
    ]
    expect(mergeJUnit(gradle, known).map((r) => r.id)).toEqual(['sample.MathTest::adds', 'sample.MathTest::addsPairs', 'sample.Other::Custom display name'])
    expect(parseJavaTests(readFileSync(join(FIXTURE, 'java/src/test/java/sample/MathTest.java'), 'utf8')).filter((t) => t.multi).map((t) => t.method)).toEqual([
      'addsPairs'
    ])
    expect(jvmFilter('maven', { projectId: 'x', file: 'sample.MathTest', titlePath: ['adds'] })).toEqual(['-Dtest=sample.MathTest#adds'])
  })

  it('lists for Maven only the classes Surefire runs (default names, or the POM includes / excludes)', () => {
    const none = { includes: [], excludes: [] }
    expect(['a/MathTest.java', 'a/TestMath.java', 'a/MathTests.java', 'a/MathTestCase.java'].every((p) => surefireRuns(p, none))).toBe(true)
    expect(surefireRuns('a/MathChecks.java', none)).toBe(false)
    expect(surefireRuns('a/MathTestHelper.java', none)).toBe(false)

    const pom = `<project><build><plugins>
      <plugin><artifactId>maven-compiler-plugin</artifactId><configuration><includes><include>nope</include></includes></configuration></plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <configuration>
          <includes><include>**/*Checks.java</include><include>Spec*</include></includes>
          <!-- <excludes><exclude>**/*.java</exclude></excludes> -->
          <excludes><exclude>**/slow/**</exclude></excludes>
        </configuration>
      </plugin></plugins></build></project>`
    const patterns = surefirePatterns(pom)
    expect(patterns).toEqual({ includes: ['**/*Checks.java', 'Spec*'], excludes: ['**/slow/**'] })
    expect(surefireRuns('a/MathChecks.java', patterns)).toBe(true)
    expect(surefireRuns('a/b/SpecMath.java', patterns)).toBe(true)
    expect(surefireRuns('a/MathTest.java', patterns)).toBe(false)
    expect(surefireRuns('a/slow/BigChecks.java', patterns)).toBe(false)
    expect(surefirePatterns('<project/>')).toEqual(none)
    expect(jvmFilter('maven', { projectId: 'x', file: 'sample.MathTest' })).toEqual(['-Dtest=sample.MathTest,sample.MathTest$*'])
    expect(jvmFilter('gradle', { projectId: 'x', file: 'sample.MathTest$Inner', titlePath: ['works'] })).toEqual(['--tests', 'sample.MathTest$Inner.works'])
  })
})

// ---------------------------------------------------------------------------
// The real tools on the fixture projects (each skipped when its tool is missing; CI installs them).

const hasTool = (name: string, extra: string[] = []): boolean => !!which(name) || extra.some((p) => existsSync(p))
const progressOf = () => {
  const progress: TestResult[] = []
  const sender = {
    isDestroyed: () => false,
    send: (ch: string, _root: string, _a: unknown, b: unknown) => ch === 'tests:progress' && progress.push(b as TestResult)
  } as unknown as WebContents
  return { progress, sender }
}
const statusOf = (results: TestResult[]): Record<string, string> => Object.fromEntries(results.map((r) => [r.id, r.status]))

describe('real tools on the fixture projects', () => {
  it.skipIf(!hasTool('go', ['C:\\Program Files\\Go\\bin\\go.exe']))('Go: lists, runs everything (subtests too), then one subtest', async () => {
    const go = (await discoverTests(FIXTURE)).find((p) => p.framework === 'go')!
    expect(go.relDir).toBe('go')
    expect(go.error).toBeUndefined()
    expect(go.tests.map((t) => `${t.id}@${t.source}:${t.line}`)).toEqual([
      'mathx::TestAdd@mathx/mathx_test.go:5',
      'mathx::TestFailsOnPurpose@mathx/mathx_test.go:11',
      'mathx::TestSkipped@mathx/mathx_test.go:17',
      'mathx::TestTable@mathx/mathx_test.go:21'
    ])
    const { progress, sender } = progressOf()
    const all = await runTests(FIXTURE, { projectId: 'go:go' }, sender)
    expect(all.ok).toBe(true)
    expect(statusOf(all.results)).toEqual({
      'mathx::TestAdd': 'passed',
      'mathx::TestFailsOnPurpose': 'failed',
      'mathx::TestSkipped': 'skipped',
      'mathx::TestTable > small': 'passed',
      'mathx::TestTable > large': 'passed',
      'mathx::TestTable': 'passed'
    })
    expect(all.results.find((r) => r.status === 'failed')?.message).toContain('mathx/mathx_test.go:13: Add(2, 2) = 4, want 5')
    expect(progress).toHaveLength(6)
    const one = await runTests(FIXTURE, { projectId: 'go:go', file: 'mathx', titlePath: ['TestTable', 'large'] }, sender)
    expect(Object.keys(statusOf(one.results)).sort()).toEqual(['mathx::TestTable', 'mathx::TestTable > large'])
  }, 300_000)

  it.skipIf(!hasTool('cargo', [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', 'cargo.exe')]))(
    'Rust: lists unit and integration tests, runs them all (a failure does not stop the others), then a module',
    async () => {
      const rust = (await discoverTests(FIXTURE)).find((p) => p.framework === 'cargo')!
      expect(rust.error).toBeUndefined()
      expect(rust.tests.map((t) => `${t.id}@${t.source}:${t.line}`).sort()).toEqual([
        'src/lib.rs::tests > adds@src/lib.rs:12',
        'src/lib.rs::tests > fails_on_purpose@src/lib.rs:17',
        'src/lib.rs::tests > nested > works@src/lib.rs:27',
        'src/lib.rs::tests > skipped@src/lib.rs:23',
        'tests/integration.rs::adds_from_outside@tests/integration.rs:2'
      ])
      const { progress, sender } = progressOf()
      const all = await runTests(FIXTURE, { projectId: 'cargo:rust' }, sender)
      expect(all.ok).toBe(true)
      expect(statusOf(all.results)).toEqual({
        'src/lib.rs::tests > adds': 'passed',
        'src/lib.rs::tests > fails_on_purpose': 'failed',
        'src/lib.rs::tests > nested > works': 'passed',
        'src/lib.rs::tests > skipped': 'skipped',
        'tests/integration.rs::adds_from_outside': 'passed'
      })
      expect(all.results.find((r) => r.status === 'failed')?.message).toMatch(/left: 4\s+right: 5/)
      expect(progress.length).toBeGreaterThanOrEqual(5)
      const mod = await runTests(FIXTURE, { projectId: 'cargo:rust', file: 'src/lib.rs', titlePath: ['tests', 'nested'] }, sender)
      expect(Object.keys(statusOf(mod.results))).toEqual(['src/lib.rs::tests > nested > works'])
      const exact = await runTests(FIXTURE, { projectId: 'cargo:rust', file: 'src/lib.rs', titlePath: ['tests', 'adds'], line: 12 }, sender)
      expect(Object.keys(statusOf(exact.results))).toEqual(['src/lib.rs::tests > adds'])
    },
    600_000
  )

  it.skipIf(!hasTool('dotnet', ['C:\\Program Files\\dotnet\\dotnet.exe']))('.NET: lists, runs everything with messages, then one class', async () => {
    const net = (await discoverTests(FIXTURE)).find((p) => p.framework === 'dotnet')!
    expect(net.error).toBeUndefined()
    expect(net.tests.map((t) => `${t.id}@${t.source}:${t.line}`)).toEqual([
      'SampleTests.MathTests::Adds@MathTests.cs:8',
      'SampleTests.MathTests::FailsOnPurpose@MathTests.cs:11',
      'SampleTests.MathTests::Skipped@MathTests.cs:14',
      'SampleTests.MathTests::AddsPairs(a: 1, b: 1)@MathTests.cs:19',
      'SampleTests.MathTests::AddsPairs(a: 1000, b: 2000)@MathTests.cs:19',
      'SampleTests.MathTests+Nested::Works@MathTests.cs:24'
    ])
    const { progress, sender } = progressOf()
    const all = await runTests(FIXTURE, { projectId: 'dotnet:dotnet' }, sender)
    expect(all.ok).toBe(true)
    expect(statusOf(all.results)).toEqual({
      'SampleTests.MathTests::Adds': 'passed',
      'SampleTests.MathTests::FailsOnPurpose': 'failed',
      'SampleTests.MathTests::Skipped': 'skipped',
      'SampleTests.MathTests::AddsPairs(a: 1, b: 1)': 'passed',
      'SampleTests.MathTests::AddsPairs(a: 1000, b: 2000)': 'passed',
      'SampleTests.MathTests+Nested::Works': 'passed'
    })
    expect(all.results.find((r) => r.status === 'failed')?.message).toMatch(/Assert\.Equal\(\) Failure[\s\S]*MathTests\.cs:line 11/)
    expect(progress.map((p) => p.id).sort()).toEqual(Object.keys(statusOf(all.results)).sort())
    const cls = await runTests(FIXTURE, { projectId: 'dotnet:dotnet', file: 'SampleTests.MathTests+Nested' }, sender)
    expect(Object.keys(statusOf(cls.results))).toEqual(['SampleTests.MathTests+Nested::Works'])
  }, 600_000)

  it.skipIf(!hasTool('mvn'))('Maven: lists from the sources, runs everything (results per class), then one method', async () => {
    const mvn = (await discoverTests(FIXTURE)).find((p) => p.framework === 'maven')!
    expect(mvn.tests.map((t) => t.id)).toEqual([
      'sample.MathTest::adds',
      'sample.MathTest::failsOnPurpose',
      'sample.MathTest::skipped',
      'sample.MathTest::addsPairs',
      'sample.MathTest$Inner::works'
    ])
    const { progress, sender } = progressOf()
    const all = await runTests(FIXTURE, { projectId: 'maven:java' }, sender)
    expect(all.ok).toBe(true)
    expect(statusOf(all.results)).toEqual({
      'sample.MathTest::adds': 'passed',
      'sample.MathTest::failsOnPurpose': 'failed',
      'sample.MathTest::skipped': 'skipped',
      'sample.MathTest::addsPairs': 'passed',
      'sample.MathTest$Inner::works': 'passed'
    })
    expect(all.results.find((r) => r.status === 'failed')?.message).toContain('2 + 2')
    expect(progress.length).toBeGreaterThanOrEqual(5)
    const one = await runTests(FIXTURE, { projectId: 'maven:java', file: 'sample.MathTest', titlePath: ['adds'], line: 15 }, sender)
    expect(statusOf(one.results)).toEqual({ 'sample.MathTest::adds': 'passed' })
    const nested = await runTests(FIXTURE, { projectId: 'maven:java', file: 'sample.MathTest$Inner' }, sender)
    expect(statusOf(nested.results)).toEqual({ 'sample.MathTest$Inner::works': 'passed' })
  }, 600_000)

  it.skipIf(!hasTool('gradle'))('Gradle: lists from the sources, runs everything (results per class), then one method', async () => {
    const gradle = (await discoverTests(FIXTURE)).find((p) => p.framework === 'gradle')!
    expect(gradle.relDir).toBe('gradle')
    expect(gradle.tests.map((t) => t.id)).toEqual([
      'sample.MathTest::adds',
      'sample.MathTest::failsOnPurpose',
      'sample.MathTest::skipped',
      'sample.MathTest::addsPairs',
      'sample.MathTest$Inner::works'
    ])
    const { progress, sender } = progressOf()
    const all = await runTests(FIXTURE, { projectId: 'gradle:gradle' }, sender)
    expect(all.ok).toBe(true)
    expect(statusOf(all.results)).toEqual({
      'sample.MathTest::adds': 'passed',
      'sample.MathTest::failsOnPurpose': 'failed',
      'sample.MathTest::skipped': 'skipped',
      'sample.MathTest::addsPairs': 'passed',
      'sample.MathTest$Inner::works': 'passed'
    })
    expect(all.results.find((r) => r.status === 'failed')?.message).toContain('2 + 2')
    expect(progress.length).toBeGreaterThanOrEqual(5)
    // Re-running only some tests (cleanTest: Gradle would otherwise skip them as "up to date").
    const one = await runTests(FIXTURE, { projectId: 'gradle:gradle', file: 'sample.MathTest', titlePath: ['adds'], line: 15 }, sender)
    expect(statusOf(one.results)).toEqual({ 'sample.MathTest::adds': 'passed' })
  }, 900_000)
})

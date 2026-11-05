import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TestCase, TestResult, TestRunRequest } from '@shared/types'
import { findFiles, findUp, isWslDir, parseJUnitXml, programCommand, readText, testId, tool, type Adapter, type JUnitCase } from './core'

/**
 * Java with Maven or Gradle (JUnit 4/5, TestNG). Neither tool lists tests
 * without building and running them, so tests are listed from the sources
 * (test annotations under src/test/java), like IDEs do before a build. Runs read
 * the JUnit XML reports, polled while the build runs: results arrive class by class.
 */

type JvmFramework = 'maven' | 'gradle'

const TEST_ANNOTATION = /@(?:org\.junit\.(?:jupiter\.api\.|jupiter\.params\.)?)?(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/

/** Test methods of a Java source: class (nested classes joined with $), method and line. */
export interface JavaTest {
  /** Class, nested classes joined with $. */
  cls: string
  method: string
  line: number
  /** Several cases (parameterized / repeated / dynamic tests): reports may name them by display name only. */
  multi?: boolean
}

export function parseJavaTests(text: string): JavaTest[] {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1]
  const out: JavaTest[] = []
  const stack: { name: string; depth: number }[] = []
  let depth = 0
  let pendingClass: string | undefined
  let pendingTest = false
  let pendingMulti = false
  let inBlockComment = false
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw
    // Comments and string literals do not declare anything.
    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      inBlockComment = false
    }
    line = line.replace(/\/\*.*?\*\//g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '')
    const open = line.indexOf('/*')
    if (open >= 0) {
      inBlockComment = true
      line = line.slice(0, open)
    }
    const annotation = TEST_ANNOTATION.exec(line)
    if (annotation) {
      pendingTest = true
      pendingMulti ||= annotation[1] !== 'Test'
    }
    const decl = line.replace(/@[\w.]+(\s*\((?:[^()]|\([^()]*\))*\))?/g, ' ')
    const cls = /\b(?:class|record|enum|interface)\s+(\w+)/.exec(decl)
    if (cls) pendingClass = cls[1]
    else if (pendingTest) {
      const m = /(?:^|[\s>\]])(\w+)\s*\(/.exec(decl)
      if (m && !/^(if|for|while|switch|catch|return|new)$/.test(m[1]) && stack.length) {
        out.push({ cls: (pkg ? pkg + '.' : '') + stack.map((s) => s.name).join('$'), method: m[1], line: i + 1, ...(pendingMulti ? { multi: true } : {}) })
        pendingTest = false
        pendingMulti = false
      }
    }
    for (const ch of line) {
      if (ch === '{') {
        depth++
        if (pendingClass) {
          stack.push({ name: pendingClass, depth })
          pendingClass = undefined
        }
      } else if (ch === '}') {
        if (stack.length && stack[stack.length - 1].depth === depth) stack.pop()
        depth--
      }
    }
  })
  return out
}

/**
 * A JUnit report case's id: class + method (a parameterized test's cases share their method's id).
 * Reports name cases "adds()" / "adds" (Surefire, Gradle) or "addsPairs(int, int)[1]" (Surefire), but
 * Gradle names a parameterized / repeated case by its display name only ("[1] 1, 1", "repetition 1 of 3"):
 * with the class's known tests (`known`), such a case belongs to the class's only multi-case test.
 */
export function junitId(c: Pick<JUnitCase, 'classname' | 'name'>, known?: JavaTest[]): string {
  const method = c.name.replace(/[([].*$/s, '').trim()
  const tests = known?.filter((t) => t.cls === c.classname)
  if (tests?.length && !tests.some((t) => t.method === method)) {
    const multi = tests.filter((t) => t.multi)
    if (multi.length === 1) return testId(c.classname, [multi[0].method])
    // Unknown (a custom display name): a row of its own, under the display name.
    return testId(c.classname, [c.name])
  }
  return testId(c.classname, [method || c.name])
}

/** Cases merged per id: failed if any case failed, durations added up, messages joined. */
export function mergeJUnit(cases: JUnitCase[], known?: JavaTest[]): TestResult[] {
  const byId = new Map<string, TestResult>()
  for (const c of cases) {
    const id = junitId(c, known)
    const prev = byId.get(id)
    const status: TestResult['status'] = c.status
    const duration = c.time !== undefined ? c.time * 1000 : undefined
    if (!prev) byId.set(id, { id, status, duration, message: c.message })
    else {
      prev.status = prev.status === 'failed' || status === 'failed' ? 'failed' : prev.status === 'passed' || status === 'passed' ? 'passed' : 'skipped'
      prev.duration = (prev.duration ?? 0) + (duration ?? 0)
      if (c.message) prev.message = [prev.message, c.message].filter(Boolean).join('\n\n')
    }
  }
  return [...byId.values()]
}

/** The build tool's filter for a run: a class (and its nested classes) or a test method. */
export function jvmFilter(framework: JvmFramework, req: TestRunRequest): string[] {
  if (!req.file) return []
  const cls = req.file
  const method = req.titlePath?.length ? req.titlePath[req.titlePath.length - 1] : undefined
  if (framework === 'maven') return [`-Dtest=${method ? `${cls}#${method}` : `${cls},${cls}$*`}`]
  return method ? ['--tests', `${cls}.${method}`] : ['--tests', cls, '--tests', `${cls}$*`]
}

/** JUnit XML reports under the project: Surefire (target/surefire-reports) or Gradle (build/test-results/<task>). */
export function reportFiles(dir: string, framework: JvmFramework, maxDepth = 6): string[] {
  const out: string[] = []
  const wanted = framework === 'maven' ? /(^|\/)target\/surefire-reports\/TEST-[^/]+\.xml$/ : /(^|\/)build\/test-results\/[^/]+\/TEST-[^/]+\.xml$/
  const walk = (d: string, rel: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < maxDepth && !['node_modules', '.git', '.gradle', 'src', 'classes'].includes(e.name)) walk(join(d, e.name), r, depth + 1)
      } else if (wanted.test(r)) out.push(r)
    }
  }
  walk(dir, '', 0)
  return out
}

/** Test methods in the project's test sources (src/test/java of every module), with their file. */
function javaTests(dir: string): (JavaTest & { source: string })[] {
  return findFiles(dir, ['.java'])
    .filter((p) => /(^|\/)src\/test\/java\//.test(p))
    .flatMap((f) => parseJavaTests(readText(join(dir, f))).map((t) => ({ ...t, source: f })))
}

function command(framework: JvmFramework, dir: string, args: string[]) {
  const win = process.platform === 'win32' && !isWslDir(dir)
  const wrapper = framework === 'maven' ? findUp(dir, [win ? 'mvnw.cmd' : 'mvnw']) : findUp(dir, [win ? 'gradlew.bat' : 'gradlew'])
  const program = wrapper ?? tool(dir, framework === 'maven' ? 'mvn' : 'gradle')
  return programCommand(dir, wrapper && isWslDir(dir) ? (framework === 'maven' ? './mvnw' : './gradlew') : program, args)
}

function adapter(framework: JvmFramework): Adapter {
  return {
    framework,
    detect: (_dir, names) =>
      framework === 'maven' ? names.has('pom.xml') : ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((n) => names.has(n)),
    ownsSubfolders: true,

    async list(dir) {
      const tests: TestCase[] = javaTests(dir).map((t) => ({ id: testId(t.cls, [t.method]), file: t.cls, suite: [], name: t.method, source: t.source, line: t.line }))
      return { tests }
    },

    async run(dir, req, ctx) {
      const filter = jvmFilter(framework, req)
      const args =
        framework === 'maven'
          ? ['-B', '-ntp', 'test', '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false', ...filter]
          : // cleanTest: run the tests even when Gradle considers them up to date.
            ['cleanTest', 'test', '--console=plain', ...filter]
      ctx.send(`$ ${framework === 'maven' ? 'mvn' : 'gradle'} ${args.join(' ')}\n`)
      const known = javaTests(dir)
      const mtimeOf = (f: string): number | undefined => {
        try {
          return statSync(join(dir, f)).mtimeMs
        } catch {
          return undefined
        }
      }
      // Reports already there belong to earlier runs: only files written (or rewritten) from now on count.
      const seen = new Map<string, number | undefined>(reportFiles(dir, framework).map((f) => [f, mtimeOf(f)]))
      const results = new Map<string, TestResult>()
      // Reports written during this run (a class at a time), read as they appear.
      const collect = (): void => {
        for (const f of reportFiles(dir, framework)) {
          const mtime = mtimeOf(f)
          if (mtime === undefined || seen.get(f) === mtime) continue
          seen.set(f, mtime)
          for (const r of mergeJUnit(parseJUnitXml(readText(join(dir, f))), known)) {
            results.set(r.id, r)
            ctx.result(r)
          }
        }
      }
      const timer = setInterval(collect, 1000)
      let code: number | null
      try {
        code = await ctx.exec(command(framework, dir, args))
      } finally {
        clearInterval(timer)
      }
      collect()
      if (results.size === 0 && code !== 0) return { ok: false, error: 'The build failed before running tests: see the output.', results: [], fileErrors: [] }
      return { ok: true, results: [...results.values()], fileErrors: [] }
    }
  }
}

export const mavenAdapter = adapter('maven')
export const gradleAdapter = adapter('gradle')

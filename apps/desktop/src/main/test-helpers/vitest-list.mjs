// Lists a Vitest project's tests, including skipped ones (`vitest list` leaves those out).
// Run by vibe-coding-ide with Node in the test project folder:
//   node vitest-list.mjs <path to vitest/dist/node.js> <output.json>
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [vitestNode, out] = process.argv.slice(2)
const { createVitest } = await import(pathToFileURL(vitestNode).href)
const ctx = await createVitest('test', { watch: false, run: true })
try {
  // staticParse: false = load the test files to collect their tests. Vitest 5 otherwise reads them
  // as text, which gets names with escapes or computed titles wrong and mistakes some calls for
  // tests, so the list would not match what runs.
  const { testModules, unhandledErrors } = await ctx.collect([], { staticParse: false })
  const tests = []
  for (const m of testModules) {
    for (const t of m.children.allTests()) {
      tests.push({
        name: t.fullName,
        file: t.module.moduleId,
        location: t.location,
        skipped: t.result().state === 'skipped' || undefined,
        projectName: t.project.name || undefined
      })
    }
  }
  const errors = [
    ...unhandledErrors.map((e) => String(e?.stack ?? e?.message ?? e)),
    // Files that failed to load (syntax error, failing import…).
    ...testModules.flatMap((m) => m.errors().map((e) => `${m.moduleId}\n${e.stack ?? e.message}`))
  ]
  writeFileSync(out, JSON.stringify({ tests, errors }))
} finally {
  await ctx.close()
}

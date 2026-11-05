// Vitest reporter added by vibe-coding-ide: prints each test's result as soon as it finishes,
// on a marked line the app reads (and hides from the output), for live progress.
const MARK = '@@vibe-coding-ide:test '

export default class LiveResults {
  onTestCaseResult(test) {
    const r = test.result()
    const line = {
      file: test.module.moduleId,
      name: test.fullName,
      status: r.state === 'passed' ? 'passed' : r.state === 'failed' ? 'failed' : 'skipped',
      duration: test.diagnostic()?.duration,
      message: r.errors?.length ? r.errors.map((e) => e.stack ?? e.message).join('\n\n') : undefined
    }
    process.stdout.write(`${MARK}${JSON.stringify(line)}\n`)
  }
}

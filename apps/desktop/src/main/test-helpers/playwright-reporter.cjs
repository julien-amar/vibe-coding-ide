// Playwright reporter added by vibe-coding-ide: prints each test's result as soon as it finishes,
// on a marked line the app reads (and hides from the output), for live progress.
const MARK = '@@vibe-coding-ide:test '

class LiveResults {
  onTestEnd(test, result) {
    const describes = []
    for (let s = test.parent; s && s.type === 'describe'; s = s.parent) describes.unshift(s.title)
    const status = result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed'
    const line = {
      file: test.location.file,
      titles: [...describes, test.title],
      projectName: test.parent.project()?.name || undefined,
      status,
      duration: result.duration,
      message: status === 'failed' ? result.errors.map((e) => e.stack ?? e.message ?? '').join('\n\n') : undefined
    }
    process.stdout.write(`${MARK}${JSON.stringify(line)}\n`)
  }

  printsToStdio() {
    return false
  }
}

module.exports = LiveResults

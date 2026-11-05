// Jest reporter added by vibe-coding-ide: prints each test's result as soon as it finishes,
// on a marked line the app reads (and hides from the output), for live progress.
const MARK = '@@vibe-coding-ide:test '

class LiveResults {
  onTestCaseResult(test, r) {
    const line = {
      file: test.path,
      titles: [...r.ancestorTitles, r.title],
      status: r.status === 'passed' ? 'passed' : r.status === 'failed' ? 'failed' : 'skipped',
      duration: r.duration ?? undefined,
      message: r.failureMessages && r.failureMessages.length ? r.failureMessages.join('\n\n') : undefined
    }
    process.stdout.write(`${MARK}${JSON.stringify(line)}\n`)
  }

  getLastError() {
    return undefined
  }
}

module.exports = LiveResults

// Stand-in for an AI agent CLI in end-to-end tests (put first on PATH as `claude`): prints a
// prompt, then records everything typed or pasted into it in $FAKE_AGENT_LOG.
const fs = require('fs')

const log = process.env.FAKE_AGENT_LOG
// Each start's arguments (e.g. the harness flags), one JSON line per start, next to the log.
if (log) fs.appendFileSync(`${log}.argv`, JSON.stringify(process.argv.slice(2)) + '\n')
process.stdout.write('Fake agent ready\r\n> ')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (data) => {
  if (log) fs.appendFileSync(log, data)
  // Ctrl+C / Ctrl+D end it like a real CLI.
  if (data.includes(3) || data.includes(4)) process.exit(0)
  process.stdout.write('.')
})

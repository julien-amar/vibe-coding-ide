// Stand-in for a code editor in end-to-end tests (put first on PATH as `code`): records the
// arguments it was started with in $FAKE_EDITOR_LOG, one call per line.
const fs = require('fs')

if (process.env.FAKE_EDITOR_LOG) fs.appendFileSync(process.env.FAKE_EDITOR_LOG, JSON.stringify(process.argv.slice(2)) + '\n')

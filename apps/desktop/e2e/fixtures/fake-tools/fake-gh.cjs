// Stand-in for GitHub CLI (`gh`) in end-to-end tests: records its arguments in $FAKE_GH_LOG (one
// JSON line per call) and keeps the pull requests it "created" in $FAKE_GH_LOG.prs.json, so
// `gh pr list --head <branch>` finds them afterwards. Never contacts GitHub.
const fs = require('fs')

const args = process.argv.slice(2)
const log = process.env.FAKE_GH_LOG
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\n')
const store = log ? `${log}.prs.json` : undefined
const prs = store && fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : []
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? args[args.indexOf(`--${name}`) + 1]

if (args[0] === 'pr' && args[1] === 'list') {
  const head = opt('head')
  process.stdout.write(JSON.stringify(prs.filter((p) => p.head === head).map(({ head: _h, ...p }) => p)))
} else if (args[0] === 'pr' && args[1] === 'create') {
  const number = prs.length + 1
  const pr = { number, url: `https://github.com/e2e/demo-repo/pull/${number}`, title: opt('title'), state: 'OPEN', isDraft: args.includes('--draft'), head: opt('head') }
  prs.push(pr)
  if (store) fs.writeFileSync(store, JSON.stringify(prs))
  process.stdout.write(`${pr.url}\n`)
} else {
  process.stderr.write(`fake gh: unsupported command ${args.join(' ')}\n`)
  process.exit(1)
}

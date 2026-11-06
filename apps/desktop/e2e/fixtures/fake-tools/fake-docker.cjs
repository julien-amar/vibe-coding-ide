// Stand-in for the docker CLI in end-to-end tests: records its arguments in $FAKE_DOCKER_LOG and
// prints a short progress, as `docker pull` does. Never contacts a registry.
const fs = require('fs')

const args = process.argv.slice(2)
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n')

if (args[0] === 'exec') {
  // exec -it: an interactive shell in the container (stays open, as a real one does).
  process.stdout.write(`fake shell in ${args[2]}\r\n# `)
  process.stdin.on('data', () => process.stdout.write('\r\n# '))
} else if (args[0] === 'pull') {
  process.stdout.write(`Using default tag: latest\nlatest: Pulling from library/${args[1]}\nStatus: Downloaded newer image for ${args[1]}\n`)
} else {
  process.stderr.write(`fake docker: ${args.join(' ')}\n`)
  process.exitCode = args[0] === 'fail' ? 1 : 0
}

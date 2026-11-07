// Stand-in for the docker CLI in end-to-end tests: records its arguments in $FAKE_DOCKER_LOG and
// prints a short progress, as `docker pull` does. Never contacts a registry.
const fs = require('fs')

const args = process.argv.slice(2)
if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n')

// A container's files, for `exec <id> sh -c <script> sh <path> [bytes]` (the Files view).
const FILES = {
  '/': [
    ['d', '4096 1700000000', 'etc'],
    ['d', '4096 1700000000', 'usr'],
    ['f', '25 1700000000', 'hello.txt'],
    ['f', '6 1700000000', 'blob.bin']
  ],
  '/etc': [['f', '27 1700000000', 'hosts']],
  '/usr': []
}
const CONTENT = { '/hello.txt': 'hello from the container\n', '/blob.bin': 'ab\0cd\n', '/etc/hosts': '127.0.0.1 localhost\n::1 ip6\n' }

if (args[0] === 'exec' && args[1] === '-it') {
  // exec -it: an interactive shell in the container (stays open, as a real one does).
  process.stdout.write(`fake shell in ${args[2]}\r\n# `)
  process.stdin.on('data', (d) => process.stdout.write(`\r\nran: ${String(d).trim()}\r\n# `))
} else if (args[0] === 'exec' && args[2] === 'sh' && args[3] === '-c') {
  const [script, , path] = args.slice(4)
  if (script.includes('stat -c')) {
    if (!FILES[path]) {
      process.stderr.write(`sh: cd: can't cd to ${path}\n`)
      process.exitCode = 3
    } else for (const [t, s, n] of FILES[path]) process.stdout.write(`${t}\t${s}\t${n}\n`)
  } else if (CONTENT[path] !== undefined) {
    process.stdout.write(CONTENT[path])
  } else {
    process.stderr.write(`cat: can't open '${path}': No such file or directory\n`)
    process.exitCode = 1
  }
} else if (args[0] === 'pull') {
  process.stdout.write(`Using default tag: latest\nlatest: Pulling from library/${args[1]}\nStatus: Downloaded newer image for ${args[1]}\n`)
} else {
  process.stderr.write(`fake docker: ${args.join(' ')}\n`)
  process.exitCode = args[0] === 'fail' ? 1 : 0
}

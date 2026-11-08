// Stand-ins for kubectl and k9s in end-to-end tests (the shims pass which one as the first argument).
//   kubectl config get-contexts -o name → dev, prod;   kubectl config current-context → prod
//   k9s [--context X] → prints how it was started and stays open, like the real one.
const [tool, ...args] = process.argv.slice(2)

if (tool === 'kubectl') {
  const cmd = args.join(' ')
  if (cmd === 'config get-contexts -o name') process.stdout.write('dev\nprod\n')
  else if (cmd === 'config current-context') process.stdout.write('prod\n')
  else process.exitCode = 1
} else {
  process.stdout.write(`fake k9s ${args.join(' ')}\r\n`)
  process.stdin.resume()
}

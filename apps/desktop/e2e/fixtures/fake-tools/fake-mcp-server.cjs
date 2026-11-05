// A minimal MCP server over stdio for tests: answers initialize and tools/list (two tools).
// FAKE_MCP_EXIT=<code>: exits at once (a server that fails to start).
const readline = require('readline')

if (process.env.FAKE_MCP_EXIT) {
  process.stderr.write('fake-mcp: failing on purpose\n')
  process.exit(Number(process.env.FAKE_MCP_EXIT))
}
process.stderr.write(`fake-mcp: started with ${JSON.stringify(process.argv.slice(2))}\n`)

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } })
  } else if (msg.method === 'tools/list') {
    send({
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes its input', inputSchema: { type: 'object' } },
          { name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object' } }
        ]
      }
    })
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } })
  }
})

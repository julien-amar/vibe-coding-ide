// A minimal MCP server over stdio for tests and demos: initialize, tools/list and tools/call for two
// tools (echo { text }, add { a, b }).
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
          { name: 'echo', description: 'Echoes its input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          {
            name: 'add',
            description: 'Adds two numbers',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
          }
        ]
      }
    })
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}
    const text = name === 'echo' ? String(args.text ?? JSON.stringify(args)) : name === 'add' ? String(Number(args.a) + Number(args.b)) : undefined
    if (text === undefined) send({ id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } })
    else send({ id: msg.id, result: { content: [{ type: 'text', text }] } })
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } })
  }
})

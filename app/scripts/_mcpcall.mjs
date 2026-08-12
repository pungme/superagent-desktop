import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const [,, base, ...calls] = process.argv
const url = new URL(base + `?ws=${process.env.WS || '__desktop_chat__'}&chat=test`)
const c = new Client({ name: 'probe', version: '1' })
await c.connect(new StreamableHTTPClientTransport(url))
if (calls[0] === 'list') {
  const t = await c.listTools()
  console.log(t.tools.map(x => x.name).join('\n'))
} else {
  for (const call of calls) {
    const [name, args] = call.split('|')
    const r = await c.callTool({ name, arguments: args ? JSON.parse(args) : {} })
    console.log('== ' + name + '\n' + r.content.map(x => x.text ?? '[img]').join('\n'))
  }
}
await c.close()

/** Text forms of a harness MCP server's fields (the editor shows them as plain text). */

/** Arguments typed on one line: spaces separate them; "double" or 'single' quotes keep spaces. */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  let cur = ''
  let quote: string | undefined
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) args.push(cur)
      cur = ''
      started = false
    } else cur += ch
  }
  if (started || cur) args.push(cur)
  return args
}

/** Arguments back on one line (quoted when they hold spaces or quotes). */
export const joinArgs = (args: string[] = []): string =>
  args.map((a) => (a === '' || /[\s"']/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a)).join(' ')

/** "KEY=value" (env) or "Name: value" (headers) lines as a map; blank lines and lines without a separator are skipped. */
export function parsePairs(text: string, sep: '=' | ':'): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(sep)
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    if (k) out[k] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

export const formatPairs = (pairs: Record<string, string> | undefined, sep: '=' | ':'): string =>
  Object.entries(pairs ?? {})
    .map(([k, v]) => (sep === '=' ? `${k}=${v}` : `${k}: ${v}`))
    .join('\n')

/** A skill folder as stored in the harness: relative to the project when inside it. */
export function skillPath(root: string, folder: string): string {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(folder)
  const caseless = /^[a-z]:\//i.test(r) || r.startsWith('//')
  const inside = caseless ? f.toLowerCase().startsWith(r.toLowerCase() + '/') : f.startsWith(r + '/')
  return inside ? f.slice(r.length + 1) : folder
}

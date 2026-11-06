/**
 * Partial staging: builds the patch for some lines of a one-file unified diff (`git diff` output),
 * to give to `git apply` — staging (`--cached`), unstaging (`--cached --reverse`) or discarding
 * (`--reverse`) only those lines.
 */

/** A diff whose hunks cannot be applied one by one (new / deleted / renamed / binary file). */
export function partialUnsupported(diff: string): string | undefined {
  const head = diff.slice(0, Math.max(0, diff.indexOf('\n@@')) || diff.length)
  if (/^Binary files |^GIT binary patch/m.test(diff)) return 'binary file'
  if (/^new file mode /m.test(head)) return 'new file'
  if (/^deleted file mode /m.test(head)) return 'deleted file'
  if (/^rename from /m.test(head)) return 'renamed file'
  if (!/^@@ /m.test(diff)) return 'no textual changes'
  return undefined
}

/** Indices (in diff.split('\n')) of the changed lines of each hunk. */
export function hunkLines(diff: string): number[][] {
  const lines = diff.split('\n')
  const hunks: number[][] = []
  let cur: number[] | undefined
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('@@')) hunks.push((cur = []))
    else if (cur && (l.startsWith('+') || l.startsWith('-'))) cur.push(i)
  }
  return hunks
}

/**
 * The patch keeping only the selected changed lines (indices in diff.split('\n')). Other added
 * lines are dropped and other removed lines kept as context — the other way round when the patch
 * is applied in reverse (unstaging, discarding), where the "new" side is the current content.
 * Returns undefined when no changed line is selected.
 */
export function partialPatch(diff: string, selected: Iterable<number>, reverse: boolean): string | undefined {
  const sel = new Set(selected)
  const lines = diff.split('\n')
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (first < 0) return undefined
  const out = lines.slice(0, first)
  let any = false
  let i = first
  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(lines[i])
    if (!header) {
      i++
      continue
    }
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let changes = 0
    /** Whether the previous line of the hunk was kept ("\ No newline at end of file" follows it). */
    let prevKept = false
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i]
      const c = l[0]
      if (c === '\\') {
        if (prevKept) body.push(l)
        continue
      }
      if (c === '+' || c === '-') {
        const keep = sel.has(i)
        if (keep) {
          body.push(l)
          changes++
          if (c === '+') newCount++
          else oldCount++
          prevKept = true
        } else if ((c === '-' && !reverse) || (c === '+' && reverse)) {
          // A line present on the side the patch applies to stays, as context.
          body.push(` ${l.slice(1)}`)
          oldCount++
          newCount++
          prevKept = true
        } else prevKept = false
      } else if (c === ' ') {
        body.push(l)
        oldCount++
        newCount++
        prevKept = true
      } else if (l === '' && i === lines.length - 1) {
        // The newline ending the diff.
      } else if (l === '') {
        // An empty context line whose leading space was lost (some editors / configs strip it).
        body.push(' ')
        oldCount++
        newCount++
        prevKept = true
      }
    }
    if (!changes) continue
    any = true
    out.push(`@@ -${header[1]},${oldCount} +${header[2]},${newCount} @@${header[3]}`, ...body)
  }
  return any ? `${out.join('\n')}\n` : undefined
}

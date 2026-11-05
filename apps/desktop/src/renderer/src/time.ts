/** "3 minutes ago" style relative time for unix seconds. */
export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year']
  ]
  let value = diff
  for (const [step, unit] of units) {
    if (value < step) {
      const n = Math.max(1, Math.floor(value))
      return `${n} ${unit}${n > 1 ? 's' : ''} ago`
    }
    value /= step
  }
  return ''
}

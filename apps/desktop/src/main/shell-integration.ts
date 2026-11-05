/**
 * Shells launched by DevHub report their working directory after each prompt
 * (see profiles.ts); this extracts the last reported directory from output.
 */

/** OSC 9;9;"path" (Windows Terminal convention) and OSC 7;file://host/path. */
const OSC_CWD = /\x1b\](?:9;9;"?([^"\x07\x1b]*)"?|7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*))(?:\x07|\x1b\\)/g

export function lastReportedCwd(data: string): string | undefined {
  let cwd: string | undefined
  for (const m of data.matchAll(OSC_CWD)) {
    if (m[1]) cwd = m[1]
    else if (m[2]) {
      try {
        cwd = decodeURIComponent(m[2])
      } catch {
        cwd = m[2]
      }
    }
  }
  // Git Bash reports C:/Users/...; normalise to a Windows path.
  if (cwd && /^[a-z]:\//i.test(cwd)) cwd = cwd.replace(/\//g, '\\')
  return cwd
}

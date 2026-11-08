import { execFile } from 'node:child_process'
import type { Profile } from '@shared/types'

/**
 * k9s (Kubernetes in the terminal) in the launcher: one entry per kubeconfig context (from
 * kubectl, so KUBECONFIG and the kubeconfig apply as for kubectl), the current one first. Without
 * kubectl: one entry on k9s's own default context. k9s installed in a WSL distribution: the same, run
 * there, on the distribution's kubeconfig.
 */

/** Context names passed on k9s's command line: kubeconfig names as clusters make them (EKS ARNs too). */
const SAFE_CONTEXT = /^[A-Za-z0-9][\w.@:/+-]*$/

/** The launcher entries for a k9s executable and the contexts found (exported for tests). */
export function k9sEntries(
  k9s: string,
  contexts: string[],
  current: string | undefined,
  launch: (exe: string, args: string[]) => { command: string; args: string[] }
): Profile[] {
  const valid = [...new Set(contexts.map((c) => c.trim()).filter((c) => SAFE_CONTEXT.test(c)))]
  if (!valid.length) return [{ id: 'tool:k9s', name: 'k9s', kind: 'tool', ...launch(k9s, []), source: k9s }]
  const ordered = current && valid.includes(current) ? [current, ...valid.filter((c) => c !== current)] : valid
  return ordered.map((ctx) => ({
    id: `tool:k9s:${ctx}`,
    name: `k9s · ${ctx}${ctx === current ? ' (current)' : ''}`,
    kind: 'tool',
    ...launch(k9s, ['--context', ctx]),
    source: k9s
  }))
}

type SpawnSpec = (exe: string, args: string[]) => { command: string; args: string[]; verbatim: boolean }

/** A command's output ('' when it fails); a .cmd shim through cmd.exe, quoted (spawnSpec). */
const run = (spec: ReturnType<SpawnSpec>): Promise<string> =>
  new Promise((resolve) => {
    execFile(spec.command, spec.args, { encoding: 'utf8', timeout: 5000, windowsHide: true, windowsVerbatimArguments: spec.verbatim }, (err, stdout) =>
      resolve(err ? '' : stdout)
    )
  })

/** k9s entries if k9s is on PATH (`kubectl`: where the contexts come from). */
export async function k9sProfiles(
  which: (name: string) => string | undefined,
  launch: (exe: string, args: string[]) => { command: string; args: string[] },
  spawn: SpawnSpec
): Promise<Profile[]> {
  const k9s = which('k9s')
  if (!k9s) return []
  const kubectl = which('kubectl')
  if (!kubectl) return k9sEntries(k9s, [], undefined, launch)
  const [names, current] = await Promise.all([
    run(spawn(kubectl, ['config', 'get-contexts', '-o', 'name'])),
    run(spawn(kubectl, ['config', 'current-context']))
  ])
  return k9sEntries(k9s, names.split(/\r?\n/), current.trim() || undefined, launch)
}

/**
 * Run in a WSL distribution (bash -lic, so ~/.profile's PATH applies): k9s's path, then kubectl's
 * current context and contexts. Windows programs reached through WSL's PATH (/mnt/…) are not the
 * distribution's.
 */
export const WSL_K9S_PROBE = [
  'p=$(command -v k9s 2>/dev/null) || exit 0',
  'case "$p" in /mnt/*) exit 0 ;; esac',
  'echo "k9s=$p"',
  'command -v kubectl >/dev/null 2>&1 || exit 0',
  'echo "current=$(kubectl config current-context 2>/dev/null)"',
  "kubectl config get-contexts -o name 2>/dev/null | sed 's/^/ctx=/'"
].join('; ')

/** What WSL_K9S_PROBE printed (exported for tests). */
export function parseWslK9sProbe(out: string): { k9s?: string; current?: string; contexts: string[] } {
  const r: { k9s?: string; current?: string; contexts: string[] } = { contexts: [] }
  for (const line of out.split(/\r?\n/)) {
    const m = /^(k9s|current|ctx)=(.*)$/.exec(line.trim())
    if (!m) continue
    if (m[1] === 'k9s') r.k9s = m[2]
    else if (m[1] === 'current') r.current = m[2] || undefined
    else r.contexts.push(m[2])
  }
  return r
}

/**
 * The launcher entries for k9s in a WSL distribution (exported for tests): as on Windows, each
 * started in the distribution through a login shell, "(distro)" in its name.
 */
export function wslK9sEntries(distro: string, probe: { k9s?: string; current?: string; contexts: string[] }, wsl: string): Profile[] {
  if (!probe.k9s) return []
  const inDistro = (args: string[]): { command: string; args: string[] } => ({
    command: wsl,
    // (Context names are checked: SAFE_CONTEXT has no quote or space.)
    args: ['-d', distro, '--cd', '~', '--exec', 'bash', '-lic', ['exec k9s', ...args.map((a) => `'${a}'`)].join(' ')]
  })
  return k9sEntries(probe.k9s, probe.contexts, probe.current, (_exe, args) => inDistro(args)).map((p) => ({
    ...p,
    id: p.id.replace(/^tool:k9s/, `tool:k9s@${distro}`),
    name: `${p.name} (${distro})`,
    source: `${distro}: ${probe.k9s}`,
    wslDistro: distro
  }))
}

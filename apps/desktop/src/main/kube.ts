import { execFile } from 'node:child_process'
import type { Profile } from '@shared/types'

/**
 * k9s (Kubernetes in the terminal) in the launcher: one entry per kubeconfig context (from
 * kubectl, so KUBECONFIG and the kubeconfig apply as for kubectl), the current one first. Without
 * kubectl: one entry on k9s's own default context.
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

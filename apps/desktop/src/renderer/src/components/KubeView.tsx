import { useEffect, useState } from 'react'
import type { Profile } from '@shared/types'
import { loadProfiles } from '../profiles'
import { useTabs, type Tab } from '../store'
import { Spinner } from './Spinner'
import { TerminalView } from './TerminalView'

/**
 * A k9s tab: k9s in a terminal, with the Kubernetes context to look at chosen in its toolbar (every
 * context k9s was found for at app start: on Windows, and in each WSL distribution). Choosing another
 * context restarts k9s on it, in the same tab.
 */

/** The k9s profiles (one per context), Windows ones first, then by distribution. */
export function k9sContexts(profiles: Profile[]): Profile[] {
  const k9s = profiles.filter((p) => p.kind === 'tool' && p.id.startsWith('tool:k9s'))
  return [...k9s.filter((p) => !p.wslDistro), ...k9s.filter((p) => p.wslDistro).sort((a, b) => a.wslDistro!.localeCompare(b.wslDistro!))]
}

/** The context's name as the dropdown shows it ("prod (current)"; "k9s" alone: k9s's default context). */
export const contextLabel = (p: Profile): string => {
  const name = p.name.replace(/^k9s( · )?/, '').replace(new RegExp(` \\(${(p.wslDistro ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`), '')
  return name || 'Default context'
}

export function KubeView({ tab, visible }: { tab: Tab; visible: boolean }): React.JSX.Element {
  const [contexts, setContexts] = useState<Profile[]>([])
  /** Until the startup look-up (WSL distributions are woken for it) is done. */
  const [searching, setSearching] = useState(true)
  const switchTabProfile = useTabs((s) => s.switchTabProfile)

  const load = async (): Promise<void> => {
    const [listed, wsl] = await Promise.all([loadProfiles(), window.ide.profiles.wslTools()])
    setContexts(k9sContexts([...listed.filter((p) => !wsl.some((w) => w.id === p.id)), ...wsl]))
    setSearching(false)
  }
  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- once per tab

  const groups = new Map<string, Profile[]>()
  for (const p of contexts) {
    const g = p.wslDistro ?? 'Windows'
    groups.set(g, [...(groups.get(g) ?? []), p])
  }
  // The tab's context stays listed even if hidden since (or not found again).
  const current = contexts.some((p) => p.id === tab.profileId) ? undefined : tab.profileId

  return (
    <div className="kube-view">
      <div className="pane-toolbar kube-toolbar">
        <span className="kube-label">Context</span>
        <select aria-label="Kubernetes context" value={tab.profileId ?? ''} onChange={(e) => void switchTabProfile(tab.id, e.target.value)}>
          {current && <option value={current}>{current.replace(/^tool:k9s[^:]*:?/, '') || 'Default context'}</option>}
          {[...groups].map(([group, list]) =>
            groups.size > 1 ? (
              <optgroup key={group} label={group}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {contextLabel(p)}
                  </option>
                ))}
              </optgroup>
            ) : (
              list.map((p) => (
                <option key={p.id} value={p.id}>
                  {contextLabel(p)}
                </option>
              ))
            )
          )}
        </select>
        {searching && <Spinner inline label="Looking for contexts" />}
      </div>
      <div className="kube-terminal">
        {tab.sessionId && (
          <TerminalView
            key={tab.sessionId}
            sessionId={tab.sessionId}
            restoredScrollback={tab.restoredScrollback}
            visible={visible}
            onTitle={(title) => useTabs.getState().setAutoTitle(tab.id, title)}
          />
        )}
      </div>
    </div>
  )
}

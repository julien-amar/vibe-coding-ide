import { useEffect, useState } from 'react'
import type { Profile } from '@shared/types'
import { agentLogo, Logo } from '../logos'

/** Icon data URLs from the main process, fetched once per profile. */
const iconCache = new Map<string, Promise<string | null>>()

function fetchIcon(id: string): Promise<string | null> {
  let p = iconCache.get(id)
  if (!p) {
    p = window.ide.profiles.icon(id).catch(() => null)
    iconCache.set(id, p)
  }
  return p
}

interface Monogram {
  text: string
  color: string
}

/**
 * Fallback when the installed software has no usable icon: a small coloured
 * monogram, distinct per shell / distribution / agent.
 */
const KNOWN: Array<[RegExp, Monogram]> = [
  // (order matters: first match wins — agents before distros, as WSL agent ids contain the distro name)
  // AI agents
  [/^(wsl)?agent:(.+:)?claude$/, { text: 'C', color: '#d97757' }],
  [/^(wsl)?agent:(.+:)?codex$/, { text: 'Cx', color: '#10a37f' }],
  [/^(wsl)?agent:(.+:)?gemini$/, { text: 'G', color: '#4285f4' }],
  [/^(wsl)?agent:(.+:)?opencode$/, { text: 'oc', color: '#4b5563' }],
  [/^(wsl)?agent:(.+:)?pi$/, { text: 'π', color: '#8b5cf6' }],
  // Shells (matched on profile id or name)
  [/^shell:pwsh$/, { text: 'PS', color: '#2671be' }],
  [/^shell:powershell$/, { text: 'PS', color: '#012456' }],
  [/^shell:cmd$/, { text: 'C:', color: '#3c3c3c' }],
  [/^shell:git-bash$/, { text: 'GB', color: '#f05032' }],
  [/nushell|^nu$/i, { text: 'nu', color: '#3aa675' }],
  [/fish/i, { text: '><>', color: '#e66b2e' }],
  [/zsh/i, { text: 'Z', color: '#5b6b7a' }],
  [/elvish/i, { text: 'E', color: '#7a5af8' }],
  [/xonsh/i, { text: 'X', color: '#2e7d32' }],
  [/bash/i, { text: '$_', color: '#4eaa25' }],
  [/^sh$|dash/i, { text: '$', color: '#64748b' }],
  // WSL distributions
  [/ubuntu/i, { text: 'U', color: '#e95420' }],
  [/kali/i, { text: 'K', color: '#367bf0' }],
  [/debian/i, { text: 'D', color: '#a80030' }],
  [/fedora/i, { text: 'F', color: '#51a2da' }],
  [/arch/i, { text: 'A', color: '#1793d1' }],
  [/alpine/i, { text: 'Al', color: '#0d597f' }],
  [/suse/i, { text: 'S', color: '#73ba25' }],
  [/oracle/i, { text: 'O', color: '#c74634' }],
  [/alma/i, { text: 'Al', color: '#ac5ba8' }],
  [/rocky/i, { text: 'R', color: '#10b981' }]
]

function monogramFor(profile: Profile): Monogram {
  for (const [re, m] of KNOWN) if (re.test(profile.id) || re.test(profile.name)) return m
  // Unknown: initials with a colour derived from the name, so each entry stays distinct.
  let hash = 0
  for (const ch of profile.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const text = profile.name.replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?'
  return { text: text[0].toUpperCase() + text.slice(1).toLowerCase(), color: `hsl(${hash % 360} 55% 42%)` }
}

export function ProfileIcon({ profile, size = 16 }: { profile: Profile; size?: number }): React.JSX.Element {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  // AI agents: their own logo (npm installs and most agent binaries carry no icon).
  const logo = profile.kind === 'agent' ? agentLogo(profile.id) : undefined

  const hasLogo = logo !== undefined
  useEffect(() => {
    if (hasLogo) return
    let alive = true
    void fetchIcon(profile.id).then((s) => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [profile.id, hasLogo])

  if (logo) return <Logo svg={logo.svg} size={size} className={`profile-icon agent-logo ${logo.agent}`} />
  if (src) return <img className="profile-icon" src={src} width={size} height={size} alt="" draggable={false} />
  if (src === undefined) return <span className="profile-icon placeholder" style={{ width: size, height: size }} />
  const m = monogramFor(profile)
  return (
    <span
      className="profile-icon monogram"
      style={{ width: size, height: size, background: m.color, fontSize: Math.round(size * (m.text.length > 2 ? 0.42 : m.text.length > 1 ? 0.5 : 0.62)) }}
      aria-hidden
    >
      {m.text}
    </span>
  )
}

/** A new volume's type and its driver options (pure: tested). */

export type VolumeKind = 'local' | 'nfs' | 'cifs' | 'bind' | 'tmpfs' | 'custom' | 'guest' | 'vhd'

export const VOLUME_KINDS: Record<'engine' | 'wslc', { id: VolumeKind; label: string }[]> = {
  engine: [
    { id: 'local', label: 'Local (default)' },
    { id: 'nfs', label: 'NFS share' },
    { id: 'cifs', label: 'SMB / CIFS share' },
    { id: 'bind', label: "A folder of the engine's host" },
    { id: 'tmpfs', label: 'In memory (tmpfs)' },
    { id: 'custom', label: 'Another driver (plugin)…' }
  ],
  wslc: [
    { id: 'guest', label: 'guest (default)' },
    { id: 'vhd', label: 'vhd (virtual disk)' }
  ]
}

/** KEY=VALUE lines → a map (empty lines skipped; a line without "=" is an error). */
export function pairs(text: string): { map: Record<string, string>; error?: string } {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    const i = l.indexOf('=')
    if (i <= 0) return { map, error: `"${l}" is not KEY=VALUE` }
    map[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return { map }
}

/** The driver and its options for the chosen type (exported for tests). */
export function volumeSettings(kind: VolumeKind, f: Record<string, string>): { driver?: string; options: Record<string, string>; error?: string } {
  const extra = pairs(f.options ?? '')
  if (extra.error) return { options: {}, error: extra.error }
  switch (kind) {
    case 'nfs':
      if (!f.server?.trim() || !f.path?.trim()) return { options: {}, error: 'The NFS server and its exported path are needed.' }
      return {
        driver: 'local',
        options: { type: 'nfs', o: [`addr=${f.server.trim()}`, f.mount?.trim()].filter(Boolean).join(','), device: `:${f.path.trim()}`, ...extra.map }
      }
    case 'cifs':
      if (!f.share?.trim()) return { options: {}, error: 'The share (//server/share) is needed.' }
      return { driver: 'local', options: { type: 'cifs', device: f.share.trim(), ...(f.mount?.trim() ? { o: f.mount.trim() } : {}), ...extra.map } }
    case 'bind':
      if (!f.path?.trim()) return { options: {}, error: "The folder (a path on the engine's host) is needed." }
      return { driver: 'local', options: { type: 'none', o: 'bind', device: f.path.trim(), ...extra.map } }
    case 'tmpfs':
      return { driver: 'local', options: { type: 'tmpfs', device: 'tmpfs', ...(f.size?.trim() ? { o: `size=${f.size.trim()}` } : {}), ...extra.map } }
    case 'custom':
      if (!f.driver?.trim()) return { options: {}, error: 'The driver name is needed.' }
      return { driver: f.driver.trim(), options: extra.map }
    case 'guest':
    case 'vhd':
      return { driver: kind, options: extra.map }
    default:
      return { options: extra.map }
  }
}

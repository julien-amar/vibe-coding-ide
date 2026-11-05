/**
 * Windows paths into WSL distributions: \\wsl.localhost\<distro>\home\me (or the
 * older \\wsl$\<distro>\...). Returns the distro and the Linux path, or undefined
 * for regular Windows paths.
 */
export function parseWslPath(p: string): { distro: string; path: string } | undefined {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)(.*)$/i.exec(p)
  if (!m) return undefined
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return { distro: m[1], path: rest || '/' }
}

export const isWslPath = (p: string): boolean => parseWslPath(p) !== undefined

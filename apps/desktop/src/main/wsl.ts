import { join } from 'node:path'

/** Running programs inside WSL distributions from Windows (wsl.exe). */

/** wsl.exe, the launcher of WSL distributions. */
export const wslExe = (): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')

/**
 * wsl.exe arguments running a program directly in a distribution, in `cd` (a Linux path, or ~).
 * --exec runs it without the distribution's shell, so arguments arrive unmodified (no re-parsing of
 * quotes, $, %(…)).
 */
export const wslExec = (distro: string, command: string[], cd?: string): string[] => ['-d', distro, ...(cd ? ['--cd', cd] : []), '--exec', ...command]

/**
 * wsl.exe arguments running `program args…` through a bash login shell, where PATH comes from
 * ~/.profile (nvm, cargo, go…); `interactive` also reads ~/.bashrc. The program and its arguments go
 * through "$@", one argument each.
 */
export const wslLogin = (distro: string, program: string, args: string[], o: { cd?: string; interactive?: boolean } = {}): string[] =>
  wslExec(distro, ['bash', o.interactive ? '-lic' : '-lc', 'exec "$@"', program, program, ...args], o.cd)

/** WSLENV sharing these variables with the distribution too, keeping what the user already shares. */
export const wslenvWith = (...entries: string[]): string => [process.env.WSLENV, ...entries].filter(Boolean).join(':')

/** wsl.exe's own output (lists, errors) is UTF-16LE unless WSL_UTF8=1 is honored. */
export function decodeWslOutput(buf: Buffer): string {
  const looksUtf16 = buf.length >= 2 && (buf[1] === 0 || (buf[0] === 0xff && buf[1] === 0xfe))
  return (looksUtf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '').replace(/\0/g, '')
}

import { describe, expect, it } from 'vitest'
import { isWslPath, parseWslPath } from './wsl-paths'

describe('parseWslPath', () => {
  it('parses \\\\wsl.localhost and \\\\wsl$ paths', () => {
    expect(parseWslPath(String.raw`\\wsl.localhost\Ubuntu-24.04\home\me\project`)).toEqual({ distro: 'Ubuntu-24.04', path: '/home/me/project' })
    expect(parseWslPath(String.raw`\\wsl$\Debian\tmp`)).toEqual({ distro: 'Debian', path: '/tmp' })
  })

  it('accepts forward slashes, trailing separators and the distro root', () => {
    expect(parseWslPath('//wsl.localhost/kali-linux/home/me/')).toEqual({ distro: 'kali-linux', path: '/home/me' })
    expect(parseWslPath(String.raw`\\wsl.localhost\Ubuntu`)).toEqual({ distro: 'Ubuntu', path: '/' })
  })

  it('is case-insensitive on the host name', () => {
    expect(parseWslPath(String.raw`\\WSL.LOCALHOST\Ubuntu\srv`)?.path).toBe('/srv')
  })

  it('rejects regular paths', () => {
    for (const p of [String.raw`C:\Users\me`, '/home/me', String.raw`\\server\share\x`, '']) {
      expect(parseWslPath(p)).toBeUndefined()
      expect(isWslPath(p)).toBe(false)
    }
  })
})

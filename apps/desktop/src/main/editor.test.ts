import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveFileReference, resolveProjectFile } from './editor'

describe('resolving file references from test output', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-editor-'))
  mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true })
  const file = join(root, 'apps', 'web', 'src', 'a.ts')
  writeFileSync(file, 'x')
  const outside = mkdtempSync(join(tmpdir(), 'vibe-coding-ide-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'x')
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('accepts absolute paths, file:// URLs and paths relative to the test project folder', () => {
    expect(resolveProjectFile(root, file)).toBe(file)
    expect(resolveProjectFile(root, file.replace(/\\/g, '/'))).toBe(file)
    expect(resolveProjectFile(root, pathToFileURL(file).href)).toBe(file)
    expect(resolveProjectFile(root, 'src/a.ts', join(root, 'apps', 'web'))).toBe(file)
    expect(resolveProjectFile(root, 'apps/web/src/a.ts')).toBe(file)
  })

  it('resolves files outside the project (e.g. dependencies in a parent node_modules) for the editor, marked as such', () => {
    const dep = join(outside, 'secret.txt')
    expect(resolveFileReference(root, pathToFileURL(dep).href)).toEqual({ path: dep, inProject: false })
    expect(resolveFileReference(root, 'src/a.ts', join(root, 'apps', 'web'))).toEqual({ path: file, inProject: true })
  })

  it('keeps project files apart from outside files, folders and missing files', () => {
    expect(resolveProjectFile(root, join(outside, 'secret.txt'))).toBeUndefined()
    expect(resolveProjectFile(root, '../' + join(outside, 'secret.txt').split(/[\\/]/).slice(-2).join('/'))).toBeUndefined()
    expect(resolveProjectFile(root, 'src/a.ts', outside)).toBeUndefined() // a base outside the project is ignored
    expect(resolveProjectFile(root, join(root, 'apps'))).toBeUndefined()
    expect(resolveProjectFile(root, 'nope.ts')).toBeUndefined()
  })
})

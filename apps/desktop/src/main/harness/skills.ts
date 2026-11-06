import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Harness, SkillInfo } from '@shared/types'
import { readText } from '../tests/core'
import { agentPath, type HarnessTarget } from './target'

/** Skill folders of a path: the folder itself (it has a SKILL.md) or its sub-folders that have one. */
export function skillFolders(path: string): string[] {
  if (existsSync(join(path, 'SKILL.md'))) return [path]
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(path, e.name, 'SKILL.md')))
      .map((e) => join(path, e.name))
  } catch {
    return []
  }
}

export const resolveSkillPath = (root: string, p: string): string => (isAbsolute(p) ? p : resolve(root, p))

/** Enabled skill folders of a harness (relative paths start from the project). */
export const enabledSkillFolders = (harness: Harness, root: string): string[] =>
  harness.skills.filter((s) => s.enabled).flatMap((s) => skillFolders(resolveSkillPath(root, s.path)))

/** Names of the skills in skill folders (SKILL.md name, or the folder name), searched a few levels down. */
export function skillNamesIn(dirs: string[], depth = 3): string[] {
  const names = new Set<string>()
  const walk = (d: string, level: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      names.add(skillMeta(readText(join(d, 'SKILL.md'))).name ?? basename(d))
      return
    }
    if (level < depth) for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') walk(join(d, e.name), level + 1)
  }
  for (const d of dirs) walk(d, 0)
  return [...names]
}

/** Skills as a list in instructions (for agents that cannot load skill folders): where to read each. */
export function skillsCatalog(folders: string[], target: HarnessTarget = { kind: 'host' }): string {
  if (!folders.length) return ''
  const lines = folders.map((f) => {
    const meta = skillMeta(readText(join(f, 'SKILL.md')))
    return `- ${meta.name ?? basename(f)}: ${meta.description ?? '(no description)'} (file: ${agentPath(target, join(f, 'SKILL.md'))})`
  })
  return [
    '## Skills',
    'These skills are available in this session. When a task matches one, read its SKILL.md first and follow it',
    '(resolve relative paths against the folder of the SKILL.md).',
    ...lines
  ].join('\n')
}

/** name / description from a SKILL.md front matter. */
export function skillMeta(text: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (k: string): string | undefined => {
    const v = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim()
    return v ? v.replace(/^["']|["']$/g, '') : undefined
  }
  return { name: field('name'), description: field('description') }
}

function skillInfo(folder: string, source: SkillInfo['source']): SkillInfo {
  const meta = skillMeta(readFileSync(join(folder, 'SKILL.md'), 'utf8'))
  return { path: folder, name: meta.name ?? basename(folder), description: meta.description, source }
}

export function listSkills(root: string, harness: Harness): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const s of harness.skills) {
    const path = resolveSkillPath(root, s.path)
    const folders = skillFolders(path)
    if (!folders.length) out.push({ path, name: basename(path), source: 'harness', missing: true })
    for (const f of folders) out.push(skillInfo(f, 'harness'))
  }
  // What Claude Code already loads by itself (shown, not managed).
  for (const [dir, source] of [
    [join(root, '.claude', 'skills'), 'project'],
    [join(homedir(), '.claude', 'skills'), 'user']
  ] as const) {
    if (existsSync(dir)) for (const f of skillFolders(dir)) if (f !== dir) out.push(skillInfo(f, source))
  }
  return out
}

/** A skill's SKILL.md (only that file can be read this way). */
export function readSkillFile(folder: string): string {
  const file = join(folder, 'SKILL.md')
  return statSync(file).isFile() ? readFileSync(file, 'utf8') : ''
}

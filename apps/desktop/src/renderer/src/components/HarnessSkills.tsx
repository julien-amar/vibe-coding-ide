import { useEffect, useState } from 'react'
import type { AgentHarnessSupport, Harness, SkillInfo } from '@shared/types'
import { skillPath } from '../harness-form'
import { notify } from './Dialogs'

/** Agent settings, Skills tab. */

/** Skills the agent loads on its own, by where they are (a heading each, with the folder). */
const NATIVE_GROUPS: { source: SkillInfo['source']; title: string; path: string }[] = [
  { source: 'user', title: 'Global skills', path: '~/.claude/skills' },
  { source: 'project', title: 'Repository skills', path: '.claude/skills' }
]

export function SkillsView({
  root,
  harness,
  save,
  support
}: {
  root: string
  harness: Harness
  save: (h: Harness) => Promise<void>
  /** What the pane's agent supports (undefined: unknown agent). */
  support?: AgentHarnessSupport
}): React.JSX.Element {
  const canStrict = !support || support.strictSkills
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [preview, setPreview] = useState<{ path: string; text: string }>()

  useEffect(() => {
    void window.ide.harness.skills(root, harness).then(setSkills)
  }, [root, harness])

  const add = async (): Promise<void> => {
    const folder = await window.ide.harness.pickSkillFolder(root)
    if (!folder) return
    const path = skillPath(root, folder)
    if (harness.skills.some((s) => s.path === path)) return notify('This folder is already in the harness.')
    await save({ ...harness, skills: [...harness.skills, { path, enabled: true }] })
    const found = await window.ide.harness.skills(root, { ...harness, skills: [...harness.skills, { path, enabled: true }] })
    if (!found.some((s) => s.source === 'harness' && !s.missing && s.path.replace(/\\/g, '/').includes(path.replace(/\\/g, '/'))))
      notify('No SKILL.md in this folder or its sub-folders: the agent will not find a skill there.', 'error')
  }

  /** The harness entry a listed skill comes from (a folder of skills lists several). */
  const entryOf = (s: SkillInfo): number =>
    harness.skills.findIndex((h) => {
      const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const abs = /^([a-z]:|\/|\\\\)/i.test(h.path) ? h.path : `${root}/${h.path}`
      return norm(s.path) === norm(abs) || norm(s.path).startsWith(norm(abs) + '/')
    })

  const toggle = (i: number, enabled: boolean): void => void save({ ...harness, skills: harness.skills.map((s, j) => (j === i ? { ...s, enabled } : s)) })
  const remove = (i: number): void => void save({ ...harness, skills: harness.skills.filter((_, j) => j !== i) })

  const own = skills.filter((s) => s.source === 'harness')
  const native = skills.filter((s) => s.source !== 'harness')
  return (
    <div className="harness-section">
      <div className="harness-actions">
        <button className="tool-button" onClick={() => void add()}>
          + Add skill folder…
        </button>
        <span className="muted">A folder with a SKILL.md, or a folder of skills.</span>
        <span className="spacer" />
        <label
          className="harness-check"
          title={
            canStrict
              ? 'The agent ignores its other skills (yours, the repository’s, the bundled ones)'
              : `${support!.label} cannot be made to ignore its other skills`
          }
        >
          <input
            type="checkbox"
            checked={!!harness.strictSkills && canStrict}
            disabled={!canStrict}
            onChange={(e) => void save({ ...harness, strictSkills: e.target.checked || undefined })}
          />{' '}
          Only these skills
        </label>
      </div>
      {own.length === 0 && <p className="muted harness-empty">No skills added to this project's harness.</p>}
      <ul className="harness-list">
        {own.map((s) => {
          const i = entryOf(s)
          const entry = harness.skills[i]
          return (
            <li key={s.path} className={`harness-item${entry?.enabled === false ? ' disabled' : ''}`}>
              <div className="harness-row">
                <input type="checkbox" checked={entry?.enabled !== false} aria-label={`Enable ${s.name}`} onChange={(e) => toggle(i, e.target.checked)} />
                <button className="link-button harness-name" disabled={s.missing} onClick={() => void openPreview(s.path, preview, setPreview)}>
                  {s.name}
                </button>
                {s.missing ? <span className="harness-error">no SKILL.md here</span> : <span className="harness-detail">{s.description}</span>}
                <span className="spacer" />
                <button className="icon-button pane-action" title="Remove from the harness" onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
              {preview?.path === s.path && <pre className="harness-preview">{preview.text}</pre>}
            </li>
          )
        })}
      </ul>
      {NATIVE_GROUPS.map((g) => {
        const list = native.filter((s) => s.source === g.source)
        if (!list.length) return null
        return (
          <section key={g.source} className="harness-native">
            <h4 className="harness-subtitle">
              {g.title}
              <code className="harness-subtitle-path">{g.path}</code>
            </h4>
            <ul className="harness-list">
              {list.map((s) => (
                <li key={s.path} className="harness-item">
                  <div className="harness-row">
                    <button className="link-button harness-name" onClick={() => void openPreview(s.path, preview, setPreview)}>
                      {s.name}
                    </button>
                    <span className="harness-detail">{s.description}</span>
                  </div>
                  {preview?.path === s.path && <pre className="harness-preview">{preview.text}</pre>}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

async function openPreview(path: string, current: { path: string } | undefined, set: (p: { path: string; text: string } | undefined) => void): Promise<void> {
  if (current?.path === path) return set(undefined)
  set({ path, text: (await window.ide.harness.readSkill(path)) || '(empty)' })
}

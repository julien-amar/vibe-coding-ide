import { create } from 'zustand'
import { panesOf, removePane } from '@shared/layout'
import type { GitRepo, LayoutNode } from '@shared/types'

/**
 * The git repositories of each project folder (looked for when the project opens, and by the Git
 * panel's refresh): no repository, no Git panel; several, a choice in the Git panel.
 */
interface GitReposState {
  byRoot: Record<string, GitRepo[]>
  load(root: string): Promise<GitRepo[]>
}

export const useGitReposStore = create<GitReposState>((set) => ({
  byRoot: {},
  async load(root) {
    let repos: GitRepo[] = []
    try {
      repos = await window.ide.git.repos(root)
    } catch {
      repos = []
    }
    set((s) => ({ byRoot: { ...s.byRoot, [root]: repos } }))
    return repos
  }
}))

/** A project folder's repositories (undefined: not looked for yet). */
export const useGitRepos = (root: string | undefined): GitRepo[] | undefined => useGitReposStore((s) => (root ? s.byRoot[root] : undefined))

/** A project layout without its Git panels (a folder without any repository). */
export function withoutGitPanes(layout: LayoutNode): LayoutNode {
  let out: LayoutNode | null = layout
  for (const p of panesOf(layout)) if (p.type === 'git' && out) out = removePane(out, p.id)
  return out ?? layout
}

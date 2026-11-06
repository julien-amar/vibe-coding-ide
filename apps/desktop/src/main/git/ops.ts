import type { GitOpRequest, GitOpResult } from '@shared/types'
import { partialPatch, partialUnsupported } from '@shared/git-patch'
import { parseWslPath } from '@shared/wsl-paths'
import { createPr, prInfo } from './pull-requests'
import {
  DIFF_FLAGS,
  fileDiff,
  gitBranches,
  gitStatus,
  gitWorktrees,
  parseNameStatus,
  pathKey,
  pathList,
  startPoint,
  toProjectPath,
  validBranch,
  validHash,
  worktreeDir
} from './repo'
import { git, NETWORK } from './run'

/**
 * All write/read actions the Git panel can perform. Each maps to a fixed git
 * command line; user-provided values are validated and passed after `--`
 * where git allows it, so a renderer can never inject arbitrary git options.
 */
export async function gitOp(root: string, req: GitOpRequest): Promise<GitOpResult> {
  try {
    switch (req.op) {
      case 'status':
        return { ok: true, status: await gitStatus(root) }
      case 'diff': {
        const path = pathList(req.path)[0]
        let text: string
        if (req.untracked) text = await git(root, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path], { okCodes: [1] })
        else text = await fileDiff(root, path, !!req.staged)
        return { ok: true, text }
      }
      case 'applyLines': {
        // Stage / unstage / discard some lines: a patch of those lines, applied by git.
        const path = pathList(req.path)[0]
        const staged = !!req.staged
        const action = req.action
        if (staged ? action !== 'unstage' : action !== 'stage' && action !== 'discard') throw new Error('Invalid action')
        const diff = await fileDiff(root, path, staged)
        if (diff !== req.diffText) throw new Error('The file changed meanwhile: check its changes again.')
        const why = partialUnsupported(diff)
        if (why) throw new Error(`The lines of a ${why} cannot be ${action === 'discard' ? 'discarded' : `${action}d`} separately.`)
        const patch = partialPatch(
          diff,
          (req.lines ?? []).filter((n) => Number.isInteger(n)),
          action !== 'stage'
        )
        if (!patch) throw new Error('No changed line selected.')
        const args = [
          'apply',
          ...(action === 'discard' ? [] : ['--cached']),
          ...(action === 'stage' ? [] : ['--reverse']),
          '--recount',
          '--whitespace=nowarn',
          '-'
        ]
        await git(root, args, { input: patch })
        return { ok: true }
      }
      case 'prInfo': {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { remote, web, ...pr } = await prInfo(root)
        return { ok: true, pr }
      }
      case 'createPr':
        return { ok: true, ...(await createPr(root, req)) }
      case 'stage':
        await git(root, ['add', '-A', '--', ...pathList(req.paths)])
        return { ok: true }
      case 'unstage':
        await git(root, ['restore', '--staged', '--', ...pathList(req.paths)]).catch(async () => {
          // No commit yet: there is no HEAD to restore from.
          await git(root, ['rm', '-r', '-q', '--cached', '--', ...pathList(req.paths)])
        })
        return { ok: true }
      case 'discard':
        // Untracked files are deleted; tracked files go back to their staged/committed content.
        if (req.untracked) await git(root, ['clean', '-f', '-q', '--', ...pathList(req.paths)])
        else await git(root, ['restore', '--worktree', '--', ...pathList(req.paths)])
        return { ok: true }
      case 'lastMessage': {
        // The last commit's full message (to amend it); none in a repository without commits.
        const text = await git(root, ['log', '-1', '--format=%B']).catch(() => '')
        return { ok: true, text: text.replace(/\s+$/, '') }
      }
      case 'commit': {
        const message = String(req.message ?? '')
        if (!message.trim() && !req.amend) throw new Error('Enter a commit message')
        const args = ['commit', '--cleanup=strip']
        if (req.amend) args.push('--amend')
        if (message.trim()) args.push('-F', '-')
        else args.push('--no-edit')
        const out = await git(root, args, { input: message.trim() ? message : undefined, timeout: 60000 })
        return { ok: true, text: out }
      }
      case 'branches':
        return { ok: true, branches: await gitBranches(root), worktrees: await gitWorktrees(root) }
      case 'switch': {
        const name = await validBranch(root, req.branch)
        // Switching to "origin/x" creates (or reuses) a local tracking branch "x".
        if (req.remote) {
          const local = name.replace(/^[^/]+\//, '')
          const exists = (await gitBranches(root)).some((b) => !b.remote && b.name === local)
          await git(root, exists ? ['switch', local] : ['switch', '--track', name])
        } else await git(root, ['switch', name])
        return { ok: true }
      }
      case 'createBranch': {
        const name = await validBranch(root, req.branch)
        const start = await startPoint(root, req.start)
        await git(root, req.checkout === false ? ['branch', name, ...(start ? [start] : [])] : ['switch', '-c', name, ...(start ? [start] : [])])
        return { ok: true }
      }
      case 'renameBranch': {
        const from = await validBranch(root, req.branch)
        const to = await validBranch(root, req.newName)
        await git(root, ['branch', '-m', from, to])
        return { ok: true }
      }
      case 'deleteBranch': {
        const name = await validBranch(root, req.branch)
        if (req.remote) {
          const [remote, ...rest] = name.split('/')
          await git(root, ['push', remote, '--delete', rest.join('/')], NETWORK)
        } else await git(root, ['branch', req.force ? '-D' : '-d', name])
        return { ok: true }
      }
      case 'commitFiles': {
        // Files changed by a commit, compared with its first parent (root commit: everything added).
        const hash = validHash(req.hash)
        const raw = req.parent
          ? await git(root, ['diff', '--no-color', '--name-status', '-z', '-M', validHash(req.parent), hash])
          : await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash])
        const message = await git(root, ['show', '-s', '--format=%B', hash])
        return { ok: true, files: parseNameStatus(raw), text: message.trim() }
      }
      case 'commitDiff': {
        const hash = validHash(req.hash)
        const paths = [pathList(req.path)[0], ...(req.origPath ? [String(req.origPath)] : [])]
        const text = req.parent
          ? await git(root, ['diff', '--no-color', '-M', validHash(req.parent), hash, '--', ...paths])
          : await git(root, ['show', '--no-color', '--format=', hash, '--', ...paths])
        return { ok: true, text }
      }
      case 'merge': {
        const name = await validBranch(root, req.branch)
        const out = await git(root, ['merge', '--no-edit', name], { timeout: 60000 })
        return { ok: true, text: out }
      }
      case 'fetch':
        await git(root, ['fetch', '--all', '--prune'], NETWORK)
        return { ok: true }
      case 'pull': {
        const out = await git(root, ['pull', '--no-edit'], NETWORK)
        return { ok: true, text: out }
      }
      case 'push': {
        const status = await gitStatus(root)
        // First push of a branch: publish it and set its upstream.
        const args = status.upstream ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD']
        await git(root, args, NETWORK)
        return { ok: true }
      }
      case 'addWorktree': {
        const feature = String(req.branch ?? '').trim()
        const branch = await validBranch(root, feature.includes('/') ? feature : `feature/${feature}`)
        const base = (await startPoint(root, req.start)) ?? 'HEAD'
        const dir = worktreeDir(root, feature.split('/').pop() ?? feature)
        await git(root, ['worktree', 'add', '-b', branch, '--', dir, base], { timeout: 120000 })
        return { ok: true, path: toProjectPath(root, dir), text: branch }
      }
      case 'removeWorktree': {
        const target = String(req.path ?? '')
        const key = pathKey(target)
        const wt = (await gitWorktrees(root)).find((w) => pathKey(w.path) === key)
        if (!wt || wt.main) throw new Error('Unknown worktree')
        const wsl = parseWslPath(wt.path)
        try {
          await git(root, ['worktree', 'remove', ...(req.force ? ['--force'] : []), '--', wsl ? wsl.path : wt.path], { timeout: 60000 })
        } catch (err) {
          // Windows: git unregisters the worktree and deletes its files, but cannot delete a folder a
          // process still has open. If the worktree is gone from git, that is a success with a note.
          const stillThere = (await gitWorktrees(root)).some((w) => w.path === wt.path)
          if (stillThere) throw err
          return {
            ok: true,
            text: `The worktree was removed, but the folder ${wt.path} is still in use and could not be deleted. Delete it once nothing uses it.`
          }
        }
        return { ok: true }
      }
      default:
        throw new Error('Unknown git operation')
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

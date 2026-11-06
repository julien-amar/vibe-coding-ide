import { notify, openDialog } from './Dialogs'
import type { GitRun as Run } from './GitPanel'

/** The Git panel's Pull request button. */

const HOST_LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps' }

/**
 * The branch's open pull request opens in the browser; otherwise a dialog creates one — with gh /
 * glab when installed, else on the host's "new pull request" page. The branch is pushed first.
 */
export async function pullRequest(root: string, setBusy: (s: string | null) => void, run: Run): Promise<void> {
  setBusy('Checking pull requests')
  const r = await window.ide.git.op(root, { op: 'prInfo' })
  setBusy(null)
  const pr = r.pr
  if (!r.ok || !pr) return notify(r.error ?? 'Could not read the repository', 'error')
  if (!pr.branch) return notify('Switch to a branch first.', 'error')
  if (!pr.host) return notify('The remote is not on GitHub, GitLab, Bitbucket or Azure DevOps.', 'error')
  if (pr.existing) {
    notify(`${pr.existing.draft ? 'Draft ' : ''}#${pr.existing.number}: ${pr.existing.title}`, 'info')
    window.ide.app.openExternal(pr.existing.url)
    return
  }
  if (!pr.bases.length) return notify('The remote has no branch to target yet: push a base branch first.', 'error')
  const host = HOST_LABEL[pr.host]
  const kind = pr.host === 'gitlab' ? 'merge request' : 'pull request'
  const message = pr.tool
    ? `Pushes ${pr.branch}, then creates the ${kind} on ${host} with ${pr.tool}.`
    : `Pushes ${pr.branch}, then opens ${host}'s page to create the ${kind}.` +
      (pr.toolError
        ? ` (${pr.host === 'gitlab' ? 'glab' : 'gh'} could not be used: ${pr.toolError})`
        : pr.host === 'github' || pr.host === 'gitlab'
          ? ` Install ${pr.host === 'github' ? 'GitHub CLI (gh)' : 'glab'} to create it from here.`
          : '')
  const v = await openDialog({
    title: `New ${kind}`,
    message,
    fields: [
      ...(pr.tool
        ? [
            { name: 'title', label: 'Title', value: pr.title ?? '' },
            { name: 'body', label: 'Description', kind: 'textarea' as const, placeholder: 'What changes, and why (Markdown)' }
          ]
        : []),
      { name: 'base', label: `Into (${pr.branch} →)`, options: pr.bases },
      ...(pr.tool ? [{ name: 'draft', label: 'Draft', kind: 'checkbox' as const }] : [])
    ],
    confirmLabel: pr.tool ? 'Push & create' : `Push & open ${host}`
  })
  if (!v) return
  const res = await run(pr.tool ? `Creating the ${kind}` : 'Pushing', {
    op: 'createPr',
    title: String(v.title ?? ''),
    body: String(v.body ?? ''),
    base: String(v.base),
    draft: Boolean(v.draft)
  })
  if (!res.ok || !res.url) return
  notify(res.openPage ? `Opened ${host} to create the ${kind}` : `Created ${res.url}`, 'success')
  window.ide.app.openExternal(res.url)
}

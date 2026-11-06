# vibe-coding-ide — Ideas

A parking lot for project ideas that are not (yet) in [PLAN.md](PLAN.md). Each idea gets a short problem statement, a sketch of how it could work, and open questions. When an idea is picked up, move it into the plan / roadmap.

Status legend: 💡 idea · 🔍 exploring · 📋 planned · ✅ done

---

## 💡 AI-assisted rebase & pull (automatic conflict resolution)

### Problem
`git pull --rebase` / `git rebase` on a busy branch regularly stops on conflicts. Resolving them is tedious and error-prone: switching between "ours", "theirs" and the base version, remembering what each side intended, re-running tests, then `git rebase --continue`, possibly many times in a row. vibe-coding-ide already has the pieces to help: a Git panel that knows the repository state, and an AI agent running in the same project folder.

### Idea
When a pull or rebase stops on conflicts, vibe-coding-ide offers **"Resolve with AI"**. An agent (Claude Code, Codex, … — the project's favourite agent) resolves each conflicted file using full context, vibe-coding-ide shows the proposed resolution as a diff for review, and the rebase continues commit by commit — the user stays in control of what gets applied.

### Possible flow
1. **Detect** the state: the Git panel already polls `git status`; add detection of an in-progress rebase/merge (`.git/rebase-merge`, `.git/rebase-apply`, `MERGE_HEAD`) and of unmerged paths (`UU`, `AA`, `DU`…). Show a banner: *"Rebase stopped at commit 3/7 — 2 files in conflict · Resolve with AI · Open in terminal · Abort"*.
2. **Gather context** per conflicted file:
   - the three versions: base `git show :1:<path>`, ours `:2:<path>`, theirs `:3:<path>`;
   - the commit being replayed (message + full diff) and the upstream commits that touched the same file (`git log ORIG_HEAD..@{upstream} -- <path>`);
   - project instructions (CLAUDE.md / AGENTS.md) and, later, the harness / project MCP context.
3. **Ask the agent** for a resolution:
   - *headless*: a one-shot, non-interactive agent call per file (e.g. Claude Code's print mode), returning the resolved file content plus a short explanation;
   - *interactive*: send the task to the project's agent panel ("send to agent"), so the user can follow and steer.
4. **Review**: show the result as a diff (against ours and against theirs) with the agent's explanation; per file: **Accept** (`git add`), **Edit** (open in editor/terminal), **Reject** (keep markers, resolve manually).
5. **Verify** (optional, configurable): run the project's build/tests (test panel) before continuing; if they fail, give the failure back to the agent.
6. **Continue**: `git rebase --continue` and repeat for the next stopped commit, or `git rebase --abort` at any time.

### Modes
- **Ask each time** (default): every resolution is reviewed.
- **Auto for trivial conflicts**: accept automatically when the agent is confident *and* the change is mechanical (imports, lockfiles, formatting, both sides adding entries to a list), still logged for review.
- **Full auto** (opt-in per project): resolve, build/test, continue until done or until something fails — then stop and hand over.

### Safety rails
- Create a backup ref before starting (e.g. `refs/vibe-coding-ide/backup/<branch>-<timestamp>`) so the whole operation can be undone, in addition to `ORIG_HEAD`.
- Never push automatically; never use `--force` without explicit confirmation.
- Never resolve binary files, submodules or deleted-vs-modified conflicts without asking.
- Keep a resolution log (file, commit, agent explanation, who accepted) visible in the Git panel.
- Respect the agent's own permission model (the agent edits files; vibe-coding-ide stages and continues).

### Open questions
- Headless vs interactive agent by default? Headless is faster and reviewable; interactive lets the user steer complex conflicts.
- How to detect "semantic" conflicts that git merges cleanly but break the code? (build/test step after each replayed commit?)
- Extend to `git merge` and `git cherry-pick` with the same flow?
- Cost/time limits for large rebases (many commits × many files)?
- Which agents expose a reliable non-interactive mode (and how to pass the three versions + context)?

### Builds on
Git panel (status, branches, commit details), agent registry & AI panel, test panel (planned), harness / project MCP server (planned).

---

## 💡 Review panel (code review of a branch, a pull request or the agent's changes)

### Problem
Reviewing is where the time goes once an agent writes most of the code: a long diff across many files, read in a browser tab or a terminal, with no memory of what was already checked, and comments that have to be retyped to the agent to get them fixed. The changes an agent just made in the panel next door are the hardest to review: they are not a commit or a pull request yet.

### Idea
A **Review** panel for a project, comparing two points: the working tree vs `HEAD`, the branch vs its base (what a pull request would contain), a pull request from GitHub / GitLab (`gh pr diff`, `glab mr diff`), or **what the AI agent changed since a checkpoint** (a ref taken when its task started). The reviewer goes file by file, comments on lines, and sends comments to the agent to fix — or posts them on the pull request.

### Possible flow
1. **Choose what to review**: *Uncommitted changes*, *This branch vs main*, *Pull request #12*, *Agent changes since 10:42*. Files are listed with their size of change and grouped by folder; generated files and lockfiles folded by default.
2. **Read**: side-by-side or unified diff per file, syntax highlighted; **Viewed** checkbox per file (remembered per review, cleared when the file changes again); a progress bar (*14 / 22 files viewed*).
3. **Pre-review by the agent** (optional): a one-shot, read-only agent call summarises the change (what, why, risky parts) and leaves suggested comments anchored on lines — shown as suggestions the reviewer keeps or dismisses, never posted on their own.
4. **Comment**: click a line (or Shift+click a range, as in the Changes view) → comment; kinds *question*, *must fix*, *nit*.
5. **Act on comments**:
   - **Fix with agent**: the comments (file, lines, text) go to the project's agent panel as one task — the same bridge as "Fix with agent" in the Tests panel; the next round of review shows only what changed since.
   - **Post to the pull request**: as one review (`gh api` / `glab`), with an approve / request changes verdict.
6. **Checks next to the diff**: the Tests panel's results for the reviewed files, and lint / type errors on changed lines, so the reviewer does not run them by hand.

### Open questions
- Where comments live before posting (app data per project, or `refs/notes/`?) and how they follow lines when the code changes.
- One review at a time per project, or several (one per pull request)?
- Checkpoints for agent changes: a hidden ref, a stash-like snapshot, or the agent's own session history?
- How much of the pull request discussion (existing comments, CI results) to bring into the panel.

### Builds on
Git panel (diffs, partial staging, pull requests), Tests panel and "Fix with agent", AI agent panels and their settings, the project MCP server (planned: the agent could read the review comments itself).

---

## Backlog (smaller ideas)

- ✅ **"Send failure to agent"** from the test panel: failing test name, output and location sent to the project's agent (*Fix with agent*).
- ✅ **Partial staging**: stage / unstage individual hunks or lines in the Changes view.
- 💡 **Commit message from AI**: draft a commit message from the staged diff with the project's agent.
- ✅ **Installer & auto-update**: electron-builder packages for Windows / macOS / Linux, updates from GitHub Releases.

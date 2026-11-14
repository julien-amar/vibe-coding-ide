import type { ContainersPrefs, GitPrefs, TestsPrefs } from './types'

/** The Containers tab's options before any change (main: settings clean-up; window: until loaded). */
export const DEFAULT_CONTAINERS_PREFS: ContainersPrefs = { hidden: [], refresh: 3, confirmRemove: true }

/** The Git panel's options before any change. */
export const DEFAULT_GIT_PREFS: GitPrefs = { contextLines: 3, whitespace: 'none', ignoreBlankLines: false, pushCommand: '' }

/** Whether diffs leave some whitespace out (then they cannot be applied as patches: no partial staging). */
export const ignoresWhitespace = (p: GitPrefs): boolean => p.whitespace !== 'none' || p.ignoreBlankLines

/** The Tests panel's options before any change: Run all runs 4 test projects at once. */
export const DEFAULT_TESTS_PREFS: TestsPrefs = { runAll: 'parallel', parallelism: 4 }

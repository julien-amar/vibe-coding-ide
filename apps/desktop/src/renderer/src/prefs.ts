import { useEffect, useState } from 'react'
import type { AppSettings, GitPrefs } from '@shared/types'
import { DEFAULT_GIT_PREFS } from '@shared/settings-defaults'

/** A part of the app settings, kept up to date (its defaults until loaded). */
function usePrefs<T>(pick: (s: AppSettings) => T | undefined, defaults: T): T {
  const [prefs, setPrefs] = useState<T>(defaults)
  useEffect(() => {
    void window.ide.settings.get().then((s) => setPrefs(pick(s) ?? defaults))
    return window.ide.settings.onChanged((s: AppSettings) => setPrefs(pick(s) ?? defaults))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pick` and `defaults` are constants of each caller
  }, [])
  return prefs
}

/** The Git panel's options (every project). */
export const useGitPrefs = (): GitPrefs => usePrefs((s) => s.git, DEFAULT_GIT_PREFS)

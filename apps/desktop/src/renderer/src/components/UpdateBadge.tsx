import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/**
 * The app's own update, in the title bar: downloading (progress), ready ("Restart to update"),
 * or — when the app cannot update itself — the new version with a link to its release page.
 * Nothing is shown otherwise.
 */
export function UpdateBadge(): React.JSX.Element | null {
  const [s, setS] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    let alive = true
    void window.ide.update.status().then((v) => alive && setS(v))
    const off = window.ide.update.onStatus(setS)
    return () => {
      alive = false
      off()
    }
  }, [])

  if (s.state === 'ready') {
    return (
      <button className="update-badge ready" title={`Version ${s.version} is downloaded: restart to use it (your tabs are restored)`} onClick={() => window.ide.update.install()}>
        ↻ Restart to update
      </button>
    )
  }
  if (s.state === 'downloading') {
    return (
      <span className="update-badge" title={`Downloading version ${s.version}`}>
        Updating… {s.percent ?? 0}%
      </span>
    )
  }
  if (s.state === 'available' && s.url) {
    const url = s.url
    return (
      <button className="update-badge ready" title="Open the release page to download it" onClick={() => window.ide.app.openExternal(url)}>
        ⬇ Version {s.version} is available
      </button>
    )
  }
  return null
}

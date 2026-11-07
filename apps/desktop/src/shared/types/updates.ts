/** Updates: the app's own, and the package updates of the systems shells run on. */

/** The app's own update (from GitHub Releases). */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  /** downloading: 0–100. */
  percent?: number
  /** available: the app cannot update itself (unsigned macOS app): download it from url. */
  manual?: boolean
  url?: string
  error?: string
}

/** Pending package updates of the system a shell runs on (shown as a status bar on its terminal). */
export interface PackageUpdateInfo {
  /** "Windows" or the WSL distribution name. */
  system: string
  /** winget, apt, dnf, pacman, apk, zypper */
  manager: string
  count: number
  /** Typed into the terminal when the user accepts. */
  command: string
}

import type { ContainerBackendId } from './containers'

/** Application settings. */

/** Application-wide settings (Settings screen), kept in the app's data folder. */
export interface AppSettings {
  /** Colours: the system's, or forced light / dark. */
  theme: 'system' | 'light' | 'dark'
  /** Find WSL distributions (and the agents installed in them); off: wsl.exe is not started for that. */
  wsl: boolean
  /** Profiles (shells, distributions, agents) not offered in the launcher or as defaults. */
  hiddenProfiles: string[]
  /** Profile of new projects' terminal / AI agent panels (none: the first found). */
  defaultShell?: string
  defaultAgent?: string
  /** The Containers tab's options. */
  containers?: ContainersPrefs
}

/** Containers tab options (its ⚙ dialog). */
export interface ContainersPrefs {
  /** Engines left out of the tab. */
  hidden: ContainerBackendId[]
  /** Engine of new pulls, builds, runs, volumes, networks and Compose projects (none: the first running). */
  defaultEngine?: ContainerBackendId
  /** Seconds between refreshes while the tab is shown (0: only on demand). */
  refresh: number
  /** Ask before removing a container, image, volume or network. */
  confirmRemove: boolean
}

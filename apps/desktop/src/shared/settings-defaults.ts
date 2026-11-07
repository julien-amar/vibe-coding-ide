import type { ContainersPrefs } from './types'

/** The Containers tab's options before any change (main: settings clean-up; window: until loaded). */
export const DEFAULT_CONTAINERS_PREFS: ContainersPrefs = { hidden: [], refresh: 3, confirmRemove: true }

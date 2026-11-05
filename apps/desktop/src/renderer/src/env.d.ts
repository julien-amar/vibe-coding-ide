import type { DevHubApi } from '@shared/types'

declare global {
  interface Window {
    devhub: DevHubApi
  }
}

export {}

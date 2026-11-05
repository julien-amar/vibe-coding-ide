/** A launchable entry shown in the `+` launcher. */
export type ProfileKind = 'shell' | 'wsl' | 'agent'

export interface Profile {
  id: string
  name: string
  kind: ProfileKind
  command: string
  args: string[]
  /** Where the executable was found (for display). */
  source?: string
}

export interface PtyCreateRequest {
  profileId: string
  cols: number
  rows: number
  cwd?: string
}

export interface PtyCreateResult {
  sessionId: string
  title: string
}

/** API exposed by the preload script on `window.devhub`. */
export interface DevHubApi {
  platform: NodeJS.Platform
  profiles: {
    list(refresh?: boolean): Promise<Profile[]>
  }
  pty: {
    create(req: PtyCreateRequest): Promise<PtyCreateResult>
    /** Subscribe this window to a session; returns the buffered output so far. */
    attach(sessionId: string): Promise<string>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    kill(sessionId: string): void
    onData(cb: (sessionId: string, data: string) => void): () => void
    onExit(cb: (sessionId: string, exitCode: number) => void): () => void
  }
  app: {
    openExternal(url: string): void
  }
}

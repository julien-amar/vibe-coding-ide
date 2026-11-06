import type {
  ComposeProject,
  ContainerAction,
  ContainerBackendId,
  ContainerBackendInfo,
  ContainerInfo,
  ContainerListKind,
  ContainerListResult,
  ContainerStats,
  ContainerTarget
} from '@shared/types'

/** What the Containers tab needs from an engine (Docker / Podman through the Engine API, wslc through its CLI). */
export interface ContainerBackend {
  id: ContainerBackendId
  /** Whether the engine answers (looked up again on each call: engines start and stop). */
  info(): Promise<ContainerBackendInfo>
  list(kind: ContainerListKind): Promise<ContainerListResult>
  action(target: ContainerTarget, id: string, action: ContainerAction): Promise<void>
  prune(target: ContainerTarget): Promise<string>
  create(target: 'volume' | 'network', name: string): Promise<void>
  inspect(target: ContainerTarget, id: string): Promise<string>
  /** Streams; each returns the function that stops it. */
  logs(id: string, onText: (text: string) => void, onEnd: (error?: string) => void): Promise<() => void>
  stats(id: string, onStats: (s: ContainerStats) => void, onEnd: (error?: string) => void): Promise<() => void>
  /** The engine's command line tool (build, compose, login, exec), and its environment. */
  cli(): { command: string; env?: Record<string, string> } | undefined
}

/** Compose projects from the labels Docker Compose puts on its containers. */
export function composeProjects(containers: ContainerInfo[]): ComposeProject[] {
  const projects = new Map<string, ComposeProject>()
  for (const c of containers) {
    if (!c.compose) continue
    const p = projects.get(c.compose.project) ?? {
      name: c.compose.project,
      workingDir: c.compose.workingDir,
      configFiles: c.compose.configFiles ?? [],
      services: []
    }
    p.services.push({ name: c.compose.service, state: c.state, container: c.name })
    if (!p.configFiles.length && c.compose.configFiles) p.configFiles = c.compose.configFiles
    projects.set(p.name, p)
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Compose labels of a container (from a label map). */
export function composeOf(labels: Record<string, string> | undefined): ContainerInfo['compose'] {
  const project = labels?.['com.docker.compose.project']
  if (!project) return undefined
  const files = labels?.['com.docker.compose.project.config_files']
  return {
    project,
    service: labels?.['com.docker.compose.service'] ?? '',
    workingDir: labels?.['com.docker.compose.project.working_dir'],
    configFiles: files ? files.split(',').filter(Boolean) : undefined
  }
}

/** The Containers tab: engines, containers, images, volumes, networks, Compose; jobs and streams. */

/** Container engines: Docker and Podman through the Engine API, wslc (WSL containers) through its CLI. */
export type ContainerBackendId = 'docker' | 'podman' | 'wslc'

export interface ContainerBackendInfo {
  id: ContainerBackendId
  label: string
  /** The engine answers. */
  available: boolean
  /** Version / endpoint shown next to the name. */
  detail?: string
  /** Why it is not available (not installed, not running…). */
  error?: string
  /** What it can do (wslc: no pause, no compose). */
  features: { pause: boolean; compose: boolean; /** Environment, mounts and ports of a container can be changed (by recreating it). */ editSpec: boolean }
}

export interface ContainerPort {
  /** Published on the host (absent: only exposed). */
  host?: number
  container: number
  protocol: string
  ip?: string
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  /** running, exited, paused, created, restarting, dead… */
  state: string
  /** "Up 2 hours", "Exited (0) 3 days ago". */
  status: string
  ports: ContainerPort[]
  /** Unix seconds. */
  created?: number
  /** Started by Docker Compose. */
  compose?: { project: string; service: string; workingDir?: string; configFiles?: string[] }
}

export interface ImageInfo {
  id: string
  /** repository:tag (none: dangling). */
  tags: string[]
  /** Bytes (Engine) or a human size (wslc). */
  size: number | string
  created?: number
  /** Containers using it, when known. */
  containers?: number
}

export interface VolumeInfo {
  name: string
  driver: string
  mountpoint?: string
  created?: string
}

export interface NetworkInfo {
  id: string
  name: string
  driver: string
  scope?: string
  /** ISO date. */
  created?: string
}

/** A Docker Compose project (from its containers' labels). */
export interface ComposeProject {
  name: string
  workingDir?: string
  configFiles: string[]
  services: { name: string; state: string; container: string }[]
}

export type ContainerListKind = 'containers' | 'images' | 'volumes' | 'networks' | 'compose'

export interface ContainerListResult {
  ok: boolean
  error?: string
  containers?: ContainerInfo[]
  images?: ImageInfo[]
  volumes?: VolumeInfo[]
  networks?: NetworkInfo[]
  compose?: ComposeProject[]
}

export type ContainerTarget = 'container' | 'image' | 'volume' | 'network'

/** Actions on one object (remove: also images, volumes, networks). */
export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove'

/** Long operations through the engine's CLI, with live output (a job). */
export type ContainerJob =
  | { kind: 'pull'; image: string }
  | { kind: 'build'; context: string; dockerfile?: string; tag?: string; target?: string; buildArgs?: string[] }
  | { kind: 'run'; image: string; name?: string; ports?: string[]; env?: string[]; volumes?: string[]; network?: string; restart?: string }
  | { kind: 'compose'; project: string; action: 'up' | 'down' | 'restart' | 'pull' | 'stop'; configFiles: string[]; workingDir?: string }
  | { kind: 'logout'; registry?: string }

/** A mount of a container: a volume, a folder of the engine's host (bind), or memory (tmpfs). */
export interface ContainerMount {
  type: 'volume' | 'bind' | 'tmpfs'
  /** Volume name or host path (none for tmpfs). */
  source: string
  /** Absolute path in the container. */
  target: string
  readOnly: boolean
}

/** A published port: container port / protocol on a host port (empty: one the engine picks), on a host IP (empty: all). */
export interface ContainerPortBinding {
  container: number
  protocol: string
  hostPort: string
  hostIp: string
}

/** What can be changed on a container (by recreating it). */
export interface ContainerSpec {
  env: string[]
  mounts: ContainerMount[]
  ports: ContainerPortBinding[]
  /** Ports the image exposes that are not published ("80/tcp"). */
  exposed: string[]
}

/** A suggestion of "Pull an image": a repository, or (after a colon) one of its tags. */
export interface ImageSuggestion {
  name: string
  description?: string
  stars?: number
  official?: boolean
  /** Bytes (tags). */
  size?: number
}

/** Settings of a new volume or network. */
export interface CreateOptions {
  /** Volume: local (Docker, Podman), guest or vhd (wslc), or a plugin's. */
  driver?: string
  /** Driver options (volumes: e.g. type=nfs, o=addr=…, device=:/export). */
  options?: Record<string, string>
  labels?: Record<string, string>
}

/** An entry of a container's folder (the Files view). */
export interface ContainerFileEntry {
  name: string
  type: 'dir' | 'file' | 'link' | 'dirlink' | 'other'
  size?: number
  /** Unix seconds. */
  mtime?: number
}

/** Live stats of a container (one sample). */
export interface ContainerStats {
  cpu: number
  memUsed: number
  memLimit: number
  netRx: number
  netTx: number
  blockRead: number
  blockWrite: number
  pids?: number
}

/** A stream (logs, stats, job output) sent to the window, by id. */
export type ContainerStreamEvent =
  | { stream: string; kind: 'text'; text: string }
  | { stream: string; kind: 'stats'; stats: ContainerStats }
  | { stream: string; kind: 'end'; code?: number; error?: string }

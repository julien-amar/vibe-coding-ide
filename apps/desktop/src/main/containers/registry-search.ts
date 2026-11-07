import type { ImageSuggestion } from '@shared/types'
import type { ContainerBackend } from './backend'

/**
 * Suggestions for "Pull an image": repositories matching what is typed (the engine's registry
 * search — Docker Hub, or Podman's configured registries — else Docker Hub's public search), and
 * after a colon the repository's tags (Docker Hub).
 */

/** Docker Hub's web API (overridable for tests). */
const hub = (): string => (process.env.VIBE_CODING_IDE_DOCKER_HUB ?? 'https://hub.docker.com').replace(/\/+$/, '')

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return (await r.json()) as T
}

/**
 * A reference split into its registry (none: Docker Hub), repository and tag prefix (exported for
 * tests). `docker.io/library/nginx:1.2` → { repo: 'library/nginx', tag: '1.2', hub: true }.
 */
export function splitReference(input: string): { repo: string; tag?: string; hub: boolean } {
  let rest = input.trim()
  const slash = rest.indexOf('/')
  const first = slash > 0 ? rest.slice(0, slash) : ''
  // A registry host: has a dot or a port, or is localhost.
  const registry = first && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : ''
  if (registry) rest = rest.slice(slash + 1)
  const isHub = !registry || registry === 'docker.io' || registry === 'index.docker.io' || registry === 'registry-1.docker.io'
  const colon = rest.lastIndexOf(':')
  const repo = colon >= 0 ? rest.slice(0, colon) : rest
  return { repo: isHub && repo && !repo.includes('/') ? `library/${repo}` : repo, tag: colon >= 0 ? rest.slice(colon + 1) : undefined, hub: isHub }
}

/** The tags of a Docker Hub repository starting with `prefix` (most recently pushed first). */
async function hubTags(input: string, repo: string, prefix: string): Promise<ImageSuggestion[]> {
  const [ns, name] = repo.split('/')
  if (!ns || !name) return []
  const url = `${hub()}/v2/repositories/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/tags/?page_size=30&ordering=last_updated${prefix ? `&name=${encodeURIComponent(prefix)}` : ''}`
  const r = await getJson<{ results?: { name?: string; last_updated?: string; full_size?: number }[] }>(url)
  const base = input.slice(0, input.lastIndexOf(':'))
  return (r.results ?? [])
    .filter((t) => t.name && t.name.startsWith(prefix))
    .map((t) => ({ name: `${base}:${t.name}`, description: t.last_updated ? `Updated ${t.last_updated.slice(0, 10)}` : undefined, size: t.full_size }))
}

/** Repositories of Docker Hub matching `term` (its public search). */
async function hubSearch(term: string): Promise<ImageSuggestion[]> {
  const r = await getJson<{ results?: { repo_name?: string; short_description?: string; star_count?: number; is_official?: boolean }[] }>(
    `${hub()}/v2/search/repositories/?query=${encodeURIComponent(term)}&page_size=25`
  )
  return (r.results ?? [])
    .filter((x) => x.repo_name)
    .map((x) => ({ name: x.repo_name!, description: x.short_description || undefined, stars: x.star_count, official: !!x.is_official }))
}

/** Official images first, then by stars. */
const rank = (list: ImageSuggestion[]): ImageSuggestion[] =>
  [...list].sort((a, b) => Number(!!b.official) - Number(!!a.official) || (b.stars ?? 0) - (a.stars ?? 0))

export async function suggestImages(backend: ContainerBackend | undefined, input: string): Promise<{ ok: boolean; items: ImageSuggestion[]; error?: string }> {
  const text = input.trim()
  if (text.length < 2 || /\s/.test(text)) return { ok: true, items: [] }
  const ref = splitReference(text)
  try {
    if (ref.tag !== undefined) {
      // Tags: only Docker Hub has a public listing.
      return { ok: true, items: ref.hub ? await hubTags(text, ref.repo, ref.tag) : [] }
    }
    let items: ImageSuggestion[] = []
    if (backend?.searchImages) {
      try {
        items = await backend.searchImages(text)
      } catch {
        // The engine cannot search (not running, offline): Docker Hub below.
      }
    }
    if (!items.length && ref.hub) items = await hubSearch(text)
    return { ok: true, items: rank(items).slice(0, 25) }
  } catch (err) {
    return { ok: false, items: [], error: (err as Error).message }
  }
}

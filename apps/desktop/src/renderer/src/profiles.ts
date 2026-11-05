import { useEffect, useState } from 'react'
import type { Profile } from '@shared/types'

let cached: Promise<Profile[]> | undefined

export function loadProfiles(refresh = false): Promise<Profile[]> {
  if (!cached || refresh) cached = window.ide.profiles.list(refresh)
  return cached
}

export function useProfiles(): Profile[] {
  const [list, setList] = useState<Profile[]>([])
  useEffect(() => {
    let alive = true
    void loadProfiles().then((p) => alive && setList(p))
    return () => {
      alive = false
    }
  }, [])
  return list
}

import { useLayoutEffect, useRef } from 'react'

/**
 * A ref holding the latest `value` (a callback given as a prop…), for effects and listeners set up
 * once that must call the current one. Updated after render, never during it: a render React
 * discards cannot leave a stale value behind.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

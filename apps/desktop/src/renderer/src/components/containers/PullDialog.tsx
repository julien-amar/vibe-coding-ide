import { useEffect, useRef, useState } from 'react'
import type { ContainerBackendId, ContainerBackendInfo, ImageSuggestion } from '@shared/types'
import { Modal } from '../Modal'
import { formatBytes } from './model'

// ---------------------------------------------------------------------------
// Pull an image: a reference with suggestions from the registries (names; tags after a colon)

export function PullDialog({
  engines,
  defaultEngine,
  onClose,
  onPull
}: {
  engines: ContainerBackendInfo[]
  defaultEngine?: ContainerBackendId
  onClose: () => void
  onPull: (engine: ContainerBackendId, image: string) => void
}): React.JSX.Element {
  const [image, setImage] = useState('')
  const [engine, setEngine] = useState<ContainerBackendId | undefined>(defaultEngine ?? engines[0]?.id)
  const [items, setItems] = useState<ImageSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string>()
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => input.current?.focus(), [])

  // Suggestions, 250 ms after the last key (the latest answer wins).
  useEffect(() => {
    const text = image.trim()
    if (!engine || text.length < 2) {
      setItems([])
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    const t = setTimeout(() => {
      void window.ide.containers.searchImages(engine, text).then((r) => {
        if (!alive) return
        setSearching(false)
        setItems(r.items)
        setError(r.ok ? undefined : r.error)
        setActive(-1)
      })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [image, engine])

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (s: ImageSuggestion): void => {
    setImage(s.name)
    // Picked: the list closes (typing again, e.g. ":" for the tags, reopens it).
    setOpen(false)
    setActive(-1)
    input.current?.focus()
  }
  const submit = (): void => {
    const ref = image.trim()
    if (!ref || !engine) return
    onPull(engine, ref)
  }
  const shown = open && items.length > 0

  return (
    <Modal
      label="Pull an image"
      className="dialog ctr-pull"
      onClose={onClose}
      onSubmit={submit}
      // Escape closes the suggestions first.
      onEscape={() => {
        if (!shown) return false
        setOpen(false)
        return true
      }}
    >
      <h2>Pull an image</h2>
      <label className="dialog-field">
        <span>Image (type a name for suggestions; after a colon, its tags)</span>
        <div className="ctr-combo">
          <input
            ref={input}
            role="combobox"
            aria-expanded={shown}
            aria-controls="ctr-pull-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={shown && active >= 0 ? `ctr-pull-${active}` : undefined}
            placeholder="nginx:alpine"
            spellCheck={false}
            autoComplete="off"
            value={image}
            onChange={(e) => {
              setImage(e.target.value)
              setOpen(true)
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (!shown) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const d = e.key === 'ArrowDown' ? 1 : -1
                // -1: the typed text; wraps around.
                setActive((a) => {
                  const next = a + d
                  return next < -1 ? items.length - 1 : next >= items.length ? -1 : next
                })
              } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && items[active]) {
                e.preventDefault()
                choose(items[active])
              }
            }}
          />
          {searching && <span className="ctr-combo-busy muted">searching…</span>}
          {shown && (
            <ul className="ctr-suggest" role="listbox" id="ctr-pull-suggestions" ref={listRef} aria-label="Suggestions">
              {items.map((s, i) => (
                <li
                  key={s.name}
                  id={`ctr-pull-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(s)
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="ctr-suggest-name">
                    {s.name}
                    {s.official && <span className="ctr-suggest-official">Official</span>}
                  </span>
                  <span className="ctr-suggest-meta muted">
                    {s.stars !== undefined && `★ ${s.stars.toLocaleString()}`}
                    {s.size ? formatBytes(s.size) : ''}
                  </span>
                  {s.description && <span className="ctr-suggest-desc muted">{s.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </label>
      {error && <p className="dialog-message muted">Suggestions unavailable: {error}</p>}
      {engines.length > 1 && (
        <label className="dialog-field">
          <span>Engine</span>
          <select value={engine} onChange={(e) => setEngine(e.target.value as ContainerBackendId)}>
            {engines.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-buttons">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!image.trim() || !engine}>
          Pull
        </button>
      </div>
    </Modal>
  )
}

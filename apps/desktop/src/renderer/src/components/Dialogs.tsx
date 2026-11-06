import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/** In-app dialogs (Electron has no window.prompt) and toast notifications. */

export interface DialogField {
  name: string
  label: string
  value?: string
  placeholder?: string
  /** Render a select with these options instead of a text input. */
  options?: string[]
  kind?: 'text' | 'checkbox' | 'textarea'
}

export interface DialogRequest {
  title: string
  message?: string
  fields?: DialogField[]
  confirmLabel?: string
  danger?: boolean
}

export type DialogResult = Record<string, string | boolean>

interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

interface DialogState {
  current?: DialogRequest & { resolve: (r: DialogResult | null) => void }
  toasts: Toast[]
}

const useDialogs = create<DialogState>(() => ({ current: undefined, toasts: [] }))

/** Show a dialog; resolves with the field values, or null when cancelled. */
export function openDialog(req: DialogRequest): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    useDialogs.getState().current?.resolve(null)
    useDialogs.setState({ current: { ...req, resolve } })
  })
}

export async function confirmDialog(title: string, message: string, confirmLabel = 'OK', danger = false): Promise<boolean> {
  return (await openDialog({ title, message, confirmLabel, danger })) !== null
}

let toastId = 1
export function notify(text: string, kind: Toast['kind'] = 'info'): void {
  const id = toastId++
  useDialogs.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
  setTimeout(() => useDialogs.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 9000 : 4000)
}

function DialogBox({ req }: { req: NonNullable<DialogState['current']> }): React.JSX.Element {
  const [values, setValues] = useState<DialogResult>(() =>
    Object.fromEntries((req.fields ?? []).map((f) => [f.name, f.kind === 'checkbox' ? f.value === 'true' : (f.value ?? f.options?.[0] ?? '')]))
  )
  const firstInput = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      firstInput.current?.focus()
      if (firstInput.current instanceof HTMLInputElement) firstInput.current.select()
    })
  }, [])

  const close = (result: DialogResult | null): void => {
    useDialogs.setState({ current: undefined })
    req.resolve(result)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={req.title}
        onSubmit={(e) => {
          e.preventDefault()
          close(values)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') close(null)
        }}
      >
        <h2>{req.title}</h2>
        {req.message && <p className="dialog-message">{req.message}</p>}
        {(req.fields ?? []).map((f, i) =>
          f.kind === 'checkbox' ? (
            <label key={f.name} className="dialog-check">
              <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
              {f.label}
            </label>
          ) : (
            <label key={f.name} className="dialog-field">
              <span>{f.label}</span>
              {f.options ? (
                <select
                  ref={(el) => {
                    if (i === 0) firstInput.current = el
                  }}
                  value={String(values[f.name])}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                >
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.kind === 'textarea' ? (
                <textarea
                  className="selectable"
                  rows={6}
                  value={String(values[f.name])}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  onKeyDown={(e) => {
                    // Enter is a new line here; Ctrl+Enter confirms.
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      close(values)
                    }
                  }}
                />
              ) : (
                <input
                  ref={(el) => {
                    if (i === 0) firstInput.current = el
                  }}
                  value={String(values[f.name])}
                  placeholder={f.placeholder}
                  spellCheck={false}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
            </label>
          )
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={req.danger ? 'danger' : 'primary'}>
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function DialogHost(): React.JSX.Element {
  const current = useDialogs((s) => s.current)
  const toasts = useDialogs((s) => s.toasts)
  return (
    <>
      {current && <DialogBox key={current.title + (current.message ?? '')} req={current} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => useDialogs.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  )
}

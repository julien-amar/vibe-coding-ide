import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLatest } from '../use-latest'

/**
 * A modal dialog's frame: the backdrop (a click outside closes), the dialog element (a form when
 * `onSubmit` is given), Escape to close. Open dialogs form a stack: Escape and keys only reach the
 * top one (a confirmation over the settings closes alone). The content is the caller's.
 */

const stack: symbol[] = []

export interface ModalProps {
  /** The accessible name. */
  label: string
  className: string
  onClose: () => void
  /** A form: Enter submits. */
  onSubmit?: () => void
  /** Escape first goes here: true when handled (a suggestion list closed, a form inside handles it), else the dialog closes. */
  onEscape?: (e: KeyboardEvent) => boolean
  /** Keyboard focus starts on the dialog itself (unless already inside). */
  focusDialog?: boolean
  children: React.ReactNode
}

export function Modal({ label, className, onClose, onSubmit, onEscape, focusDialog, children }: ModalProps): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const handlers = useLatest({ onClose, onEscape })

  useEffect(() => {
    const id = Symbol(label)
    stack.push(id)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return
      if (handlers.current.onEscape?.(e)) return
      e.stopPropagation()
      e.preventDefault()
      handlers.current.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    if (focusDialog && !ref.current?.contains(document.activeElement)) ref.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      stack.splice(stack.indexOf(id), 1)
    }
  }, [label, focusDialog, handlers])

  const props = {
    className,
    role: 'dialog',
    'aria-modal': true,
    'aria-label': label,
    tabIndex: focusDialog ? -1 : undefined,
    // Typing in a dialog is not a shortcut of the window behind it.
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation()
  } as const
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {onSubmit ? (
        <form
          ref={ref as React.RefObject<HTMLFormElement>}
          {...props}
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          {children}
        </form>
      ) : (
        <div ref={ref as React.RefObject<HTMLDivElement>} {...props}>
          {children}
        </div>
      )}
    </div>,
    document.body
  )
}

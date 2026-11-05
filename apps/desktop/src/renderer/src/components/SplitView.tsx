import { Fragment, useRef } from 'react'
import type { SplitNode } from '@shared/layout'

const MIN_FRACTION = 0.08

/**
 * Renders a split node's visible children side by side (row) or stacked
 * (column) with draggable dividers between them. Sizes are fractions of the
 * full child list; hidden (collapsed) children keep their size so they come
 * back where they were. `onResize` receives the new sizes.
 */
export function SplitView({
  node,
  visible,
  onResize,
  renderChild
}: {
  node: SplitNode
  /** Per child: whether it is shown. */
  visible: boolean[]
  onResize: (sizes: number[]) => void
  renderChild: (index: number) => React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const horizontal = node.dir === 'row'
  const shown = node.children.map((_, i) => i).filter((i) => visible[i])

  /** Drag the divider between visible children `a` and `b`. */
  const startDrag = (a: number, b: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const container = ref.current
    if (!container) return
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const rect = container.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const startPos = horizontal ? e.clientX : e.clientY
    const startSizes = [...node.sizes]
    // Fractions are relative to the visible children only.
    const visibleSum = shown.reduce((acc, i) => acc + startSizes[i], 0)
    const pair = startSizes[a] + startSizes[b]
    document.body.classList.add(horizontal ? 'resizing-col' : 'resizing-row')

    const onMove = (ev: PointerEvent): void => {
      const delta = (((horizontal ? ev.clientX : ev.clientY) - startPos) / total) * visibleSum
      const min = MIN_FRACTION * visibleSum
      const sizeA = Math.min(Math.max(startSizes[a] + delta, min), pair - min)
      const sizes = [...startSizes]
      sizes[a] = sizeA
      sizes[b] = pair - sizeA
      onResize(sizes)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('resizing-col', 'resizing-row')
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  return (
    <div ref={ref} className={`split split-${node.dir}`}>
      {shown.map((i, k) => (
        <Fragment key={i}>
          {k > 0 && (
            <div
              className="splitter"
              role="separator"
              aria-orientation={horizontal ? 'vertical' : 'horizontal'}
              onPointerDown={startDrag(shown[k - 1], i)}
            />
          )}
          <div className="split-child" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            {renderChild(i)}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

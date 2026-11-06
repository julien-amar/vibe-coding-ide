import { useEffect, useRef, useState } from 'react'
import type { Harness } from '@shared/types'

/** Agent settings, Instructions tab. */

export function InstructionsView({ harness, save }: { harness: Harness; save: (h: Harness) => Promise<void> }): React.JSX.Element {
  const [text, setText] = useState(harness.instructions)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef({ harness, text })
  latest.current = { harness, text }
  const flush = (): void => {
    clearTimeout(timer.current)
    const { harness: h, text: t } = latest.current
    if (t !== h.instructions) void save({ ...h, instructions: t })
  }
  // Save when leaving the view (flush reads the latest values through a ref).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), [])

  return (
    <div className="harness-section harness-instructions">
      <p className="muted">Added to the agent's system prompt in this project — conventions, commands to use, things to avoid.</p>
      <textarea
        aria-label="Instructions"
        value={text}
        placeholder={'Use pnpm, not npm.\nRun `pnpm test` before committing.'}
        onChange={(e) => {
          setText(e.target.value)
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, 600)
        }}
        onBlur={flush}
      />
    </div>
  )
}

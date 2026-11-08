/**
 * Shown while data loads: a spinner in the middle of its container (announced as `label` to screen
 * readers). The container decides the area: the spinner fills it and centres itself.
 */
export function Spinner({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="spinner-area" role="status" aria-label={label}>
      <span className="spinner" aria-hidden />
    </div>
  )
}

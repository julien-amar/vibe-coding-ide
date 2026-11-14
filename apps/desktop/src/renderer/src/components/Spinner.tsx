/**
 * Shown while data loads: a spinner in the middle of its container (announced as `label` to screen
 * readers). The container decides the area: the spinner fills it and centres itself. `inline`: a
 * small one in a line of text (a toolbar). `caption`: what is being done, under the spinner.
 */
export function Spinner({ label = 'Loading', inline = false, caption }: { label?: string; inline?: boolean; caption?: string }): React.JSX.Element {
  if (inline) return <span className="spinner spinner-inline" role="status" aria-label={label} />
  return (
    <div className="spinner-area" role="status" aria-label={label}>
      <span className="spinner" aria-hidden />
      {/* What is being done (under the spinner). */}
      {caption && <span className="spinner-caption muted">{caption}</span>}
    </div>
  )
}

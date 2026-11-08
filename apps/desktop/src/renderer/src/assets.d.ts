declare module '*.css'

/** SVG files imported as their text (inline logos). */
declare module '*.svg?raw' {
  const svg: string
  export default svg
}

/** Images imported as their URL (bundled). */
declare module '*.png' {
  const url: string
  export default url
}

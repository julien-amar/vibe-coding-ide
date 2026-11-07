/** The Containers tab's icons (16 × 16, drawn in the current colour). */

const Svg = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <svg className="ctr-icon" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
)

export const ICONS = {
  containers: (
    <Svg>
      <rect x="1.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="8.5" y="8.5" width="6" height="5.5" rx="1" />
      <rect x="5" y="2" width="6" height="5.5" rx="1" />
    </Svg>
  ),
  images: (
    <Svg>
      <path d="M8 1.8l6 3.2-6 3.2-6-3.2z" />
      <path d="M2 8l6 3.2L14 8" />
      <path d="M2 11l6 3.2 6-3.2" />
    </Svg>
  ),
  volumes: (
    <Svg>
      <ellipse cx="8" cy="3.8" rx="5.5" ry="2" />
      <path d="M2.5 3.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.8" />
      <path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
    </Svg>
  ),
  networks: (
    <Svg>
      <circle cx="8" cy="3" r="1.8" />
      <circle cx="3" cy="13" r="1.8" />
      <circle cx="13" cy="13" r="1.8" />
      <path d="M8 4.8v3.4M8 8.2L4 11.4M8 8.2l4 3.2" />
    </Svg>
  ),
  compose: (
    <Svg>
      <rect x="2" y="2" width="12" height="3.5" rx="1" />
      <rect x="2" y="6.3" width="12" height="3.5" rx="1" />
      <rect x="2" y="10.6" width="12" height="3.5" rx="1" />
    </Svg>
  ),
  start: (
    <Svg>
      <path d="M5 3l8 5-8 5z" fill="currentColor" />
    </Svg>
  ),
  stop: (
    <Svg>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </Svg>
  ),
  restart: (
    <Svg>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13 2.5v3h-3" />
    </Svg>
  ),
  pause: (
    <Svg>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" />
    </Svg>
  ),
  shell: (
    <Svg>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" />
    </Svg>
  ),
  trash: (
    <Svg>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.6a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8.6M7 7v4.5M9 7v4.5" />
    </Svg>
  ),
  pull: (
    <Svg>
      <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5" />
      <path d="M2.5 11.5v1.5a1 1 0 001 1h9a1 1 0 001-1v-1.5" />
    </Svg>
  ),
  build: (
    <Svg>
      <path d="M9.5 2.5l4 4-1.5 1.5-4-4z" />
      <path d="M8 5.5L2.5 11a1.4 1.4 0 002 2L10 7.5" />
    </Svg>
  ),
  prune: (
    <Svg>
      <path d="M10.5 2l-3 6" />
      <path d="M4 8.5h6.5l1 5.5H3z" />
      <path d="M6 11v3M8.5 11v3" />
    </Svg>
  ),
  add: (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  folderUp: (
    <Svg>
      <path d="M1.5 4.5A1.5 1.5 0 013 3h3l1.5 1.5H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12z" />
      <path d="M6.5 7l3 2-3 2z" fill="currentColor" />
    </Svg>
  ),
  down: (
    <Svg>
      <path d="M8 2v6" />
      <path d="M4.6 4.2a5 5 0 106.8 0" />
    </Svg>
  ),
  refresh: (
    <Svg>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13 2.5v3h-3" />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M1.5 4.5A1.5 1.5 0 013 3h3l1.5 1.5H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12z" fill="currentColor" fillOpacity="0.25" />
    </Svg>
  ),
  file: (
    <Svg>
      <path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" />
      <path d="M9.5 1.5v3h3" />
    </Svg>
  ),
  link: (
    <Svg>
      <path d="M6.5 9.5l3-3" />
      <path d="M7 4.5l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8" />
      <path d="M9 11.5l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 8" />
    </Svg>
  ),
  settings: (
    <Svg>
      <path d="M6.8 1.5h2.4l.4 1.9a5 5 0 011.3.75l1.8-.6 1.2 2.1-1.4 1.3a5 5 0 010 1.5l1.4 1.3-1.2 2.1-1.8-.6a5 5 0 01-1.3.75l-.4 1.9H6.8l-.4-1.9a5 5 0 01-1.3-.75l-1.8.6-1.2-2.1 1.4-1.3a5 5 0 010-1.5L2.1 5.65l1.2-2.1 1.8.6a5 5 0 011.3-.75z" />
      <circle cx="8" cy="8" r="2.1" />
    </Svg>
  )
}

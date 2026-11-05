import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './git-panel.css'
import './panes.css'
import { App } from './App'

document.body.classList.add(`platform-${window.devhub.platform}`)
createRoot(document.getElementById('root')!).render(<App />)

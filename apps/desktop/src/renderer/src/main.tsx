import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './git-panel.css'
import './panes.css'
import './tests-panel.css'
import './harness.css'
import './welcome.css'
import './launcher.css'
import './settings.css'
import './containers.css'
import { App } from './App'

document.body.classList.add(`platform-${window.ide.platform}`)
createRoot(document.getElementById('root')!).render(<App />)

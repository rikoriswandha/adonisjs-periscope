import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import { App } from './app.tsx'
import './index.css'

/**
 * Resolve and apply the persisted theme before React mounts. Keeping this bootstrap synchronous
 * prevents the light palette from flashing while the application shell hydrates.
 */
const initialTheme = (() => {
  try {
    const stored = localStorage.getItem('periscope-theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage can be unavailable in locked-down browser contexts; system remains the safe default.
  }
  return 'system'
})()
const initialDark =
  initialTheme === 'dark' ||
  (initialTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
document.documentElement.classList.toggle('dark', initialDark)
document.documentElement.dataset.theme = initialTheme
document.documentElement.style.colorScheme = initialDark ? 'dark' : 'light'

const container = document.getElementById('app')
if (!container) {
  throw new Error('Periscope dashboard: #app mount node is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

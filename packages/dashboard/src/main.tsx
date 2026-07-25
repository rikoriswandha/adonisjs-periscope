import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.tsx'
import './index.css'

const container = document.getElementById('app')
if (!container) {
  throw new Error('Periscope dashboard: #app mount node is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

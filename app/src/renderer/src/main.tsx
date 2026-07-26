import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Apply the saved theme before first paint to avoid a dark→light flash.
;(() => {
  const saved = localStorage.getItem('cove.theme') || 'system'
  const resolved =
    saved === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : saved
  document.documentElement.setAttribute('data-theme', resolved)
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

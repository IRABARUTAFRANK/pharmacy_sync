import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './lib/supabase'
import { I18nProvider } from './lib/i18n'
import { SearchProvider } from './lib/search'
import { ScannerProvider } from './lib/scanner'
import { initTheme } from './lib/theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <SearchProvider>
        <ScannerProvider>
          <App />
        </ScannerProvider>
      </SearchProvider>
    </I18nProvider>
  </React.StrictMode>,
)

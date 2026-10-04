import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import { api } from './api/index.js';
import App from './App.jsx';

async function boot() {
  // Inline env check (not the MOCK constant) so bundlers drop the mock chunk from normal builds.
  if (import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true') {
    const { installMockApi } = await import('./api/mock/index.js');
    await installMockApi(api);
  }
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();

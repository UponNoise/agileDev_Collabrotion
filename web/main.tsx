import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PreferencesProvider } from './Preferences';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <PreferencesProvider>
    <App />
  </PreferencesProvider>
);

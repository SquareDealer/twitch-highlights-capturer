import { createRoot } from 'react-dom/client';
import { createThrClient } from './api';
import { App } from './App';
import './styles.css';

window.thr = createThrClient({
  onConnection: (connected) => window.dispatchEvent(new CustomEvent('thr:connection', { detail: connected })),
});

createRoot(document.getElementById('root')!).render(<App />);

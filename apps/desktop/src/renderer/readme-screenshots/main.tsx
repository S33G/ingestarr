import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../App';
import { createReadmeScreenshotApi } from './mock-api';
import '../styles.css';

window.ingestarr = createReadmeScreenshotApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

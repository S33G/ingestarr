import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { contentSecurityPolicyPlugin } from './src/renderer/content-security-policy';

export default defineConfig({
  root: 'src/renderer',
  build: {
    outDir: '../../.vite/renderer/main_window',
  },
  plugins: [contentSecurityPolicyPlugin(), react()],
});

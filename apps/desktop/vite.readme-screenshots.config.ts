import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { contentSecurityPolicyPlugin } from './src/renderer/content-security-policy';

export default defineConfig({
  root: 'src/renderer/readme-screenshots',
  plugins: [contentSecurityPolicyPlugin(), react()],
  server: {
    port: 5199,
    strictPort: true,
  },
});

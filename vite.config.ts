import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// The frontend is a plain SPA. It talks to the Mastra server over HTTP using a
// Kinde access token, so there is no server-side session to keep in sync.
export default defineConfig({
  plugins: [react()],
  root: 'src/app',
  envDir: '../../',
  build: {
    outDir: '../../dist/app',
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});

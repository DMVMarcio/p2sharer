import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: '../../public',
  envDir: '../..',
  server: {
    port: 1422,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot('.')] },
    proxy: { '/api': 'http://127.0.0.1:3000', '/mqtt': { target: 'ws://127.0.0.1:3000', ws: true } },
  },
  build: { outDir: 'dist' },
});

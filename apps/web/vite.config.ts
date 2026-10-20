import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadWorkspaceEnvironment, deploymentSettings, publicEnvironment, workspaceRoot } from '../../tools/environment.mjs';

export default defineConfig(({ mode }) => {
  const settings = deploymentSettings(loadWorkspaceEnvironment(mode), mode);
  return {
  plugins: [react()],
  publicDir: '../../public',
  envDir: workspaceRoot,
  define: publicEnvironment(settings),
  server: {
    port: settings.webPort,
    strictPort: true,
    fs: { allow: [workspaceRoot] },
    proxy: { '/api': { target: settings.apiUrl, changeOrigin: true }, '/mqtt': { target: new URL(settings.brokerUrl).origin, changeOrigin: true, ws: true, rewrite: () => new URL(settings.brokerUrl).pathname } },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@floating-ui/')) {
            return 'vendor-floating-ui';
          }
        },
      },
    },
  },
};
});

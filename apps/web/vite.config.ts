import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadWorkspaceEnvironment, deploymentSettings, publicEnvironment, workspaceRoot } from '../../tools/environment.mjs';

/** Indexable public pages listed in the sitemap. */
const SITE_PAGES = ['/', '/download', '/privacy'];

/**
 * Injects the configured public site origin into index.html metadata and emits the
 * crawler files and social share image. Room URLs and the API stay out of search indexes.
 */
function siteSeo(siteUrl: string): Plugin {
  const origin = siteUrl.replace(/\/$/, '');
  return {
    name: 'p2sharer-site-seo',
    transformIndexHtml: { order: 'pre', handler: html => html.replaceAll('%SITE_URL%', origin) },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt',
        source: ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /app/', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n') });
      const urls = SITE_PAGES.map(page => `  <url><loc>${origin}${page}</loc></url>`);
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml',
        source: ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n') });
      this.emitFile({ type: 'asset', fileName: 'p2sharer-share.png',
        source: readFileSync(new URL('../../src-tauri/icons/icon.png', import.meta.url)) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const settings = deploymentSettings(loadWorkspaceEnvironment(mode), mode);
  return {
  plugins: [react(), siteSeo(settings.siteUrl)],
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

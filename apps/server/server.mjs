import { loadWorkspaceEnvironment, deploymentSettings } from '../../tools/environment.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSignalingBroker } from './signaling.mjs';
import { latestDownloads, releasesUrl } from './downloads.mjs';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web/dist');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const releases = releasesUrl;

/** Same-origin API and production asset host. Room content stays on the P2P mesh. */
export async function createWebServer({ root = webRoot, downloads = latestDownloads, signaling = {}, apiAllowedOrigins = ['https://p2sharer.com'] } = {}) {
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:*; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const isApi = (request.url ?? '').split('?')[0].startsWith('/api/');
    if (isApi) {
      response.setHeader('Vary', 'Origin');
      const origin = request.headers.origin;
      if (origin && !apiAllowedOrigins.includes(origin)) return send(403, JSON.stringify({ error: 'Origin not allowed' }));
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        if (!origin) return send(403, JSON.stringify({ error: 'Origin required' }));
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return send(204, '');
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return send(405, JSON.stringify({ error: 'Method not allowed' }));
    }
    try {
      // Reject malformed encodings and traversal before resolving any filesystem path.
      const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
      if (path.includes('\0') || path.includes('\\') || path.split('/').some(part => part === '..' || part.startsWith('.'))) {
        return send(400, JSON.stringify({ error: 'Invalid path' }));
      }
      if (path === '/api/health') return send(200, JSON.stringify({ status: 'ok' }));
      if (path === '/api/config') return send(200, JSON.stringify({ runtime: 'web', downloadsUrl: releases }));
      if (path === '/api/downloads') {
        try { return send(200, JSON.stringify(await downloads())); }
        catch { return send(503, JSON.stringify({ error: 'Downloads temporarily unavailable' })); }
      }
      if (path === '/api/download') {
        response.writeHead(302, { Location: releases });
        return response.end();
      }
      if (path.startsWith('/api/')) return send(404, JSON.stringify({ error: 'Not found' }));
      const route = path === '/' || path === '/download' || path === '/downloads' || path === '/app' || path === '/app/' || /^\/app\/[0-9a-f]{32}\/?$/.test(path);
      const file = resolve(root, route ? 'index.html' : `.${path}`);
      if (!file.startsWith(resolve(root) + sep)) return send(400, JSON.stringify({ error: 'Invalid path' }));
      if (!(await stat(file)).isFile()) return send(404, JSON.stringify({ error: 'Not found' }));
      if (path.startsWith('/assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return send(200, await readFile(file), contentTypes[extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      const status = error instanceof URIError ? 400 : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500;
      return send(status, JSON.stringify({ error: status === 500 ? 'Server error' : 'Not found' }));
    }
  });
  const closeBroker = await attachSignalingBroker(server, signaling);
  const closeHttp = server.close.bind(server);
  let closing;
  server.close = callback => {
    closing ??= closeBroker().then(() => new Promise((resolve, reject) => closeHttp(error => error ? reject(error) : resolve())));
    closing.then(() => callback?.(), error => callback?.(error));
    return server;
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : process.env.NODE_ENV || 'production';
  const settings = deploymentSettings(loadWorkspaceEnvironment(mode), mode);
  const server = await createWebServer({ apiAllowedOrigins: settings.apiAllowedOrigins,
    signaling: { trustProxy: settings.trustProxy, allowedOrigins: settings.brokerAllowedOrigins } });
  server.listen(settings.backendPort, settings.host, () => console.info(`P2Sharer web server ready on port ${settings.backendPort}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

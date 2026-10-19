import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web/dist');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const releases = 'https://github.com/DMVMarcio/p2sharer/releases/latest';

/** Same-origin API and production asset host. Room content stays on the P2P mesh. */
export function createWebServer({ root = webRoot } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:; worker-src 'self' blob:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
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
      if (path === '/api/download') {
        response.writeHead(302, { Location: releases });
        return response.end();
      }
      if (path.startsWith('/api/')) return send(404, JSON.stringify({ error: 'Not found' }));
      const route = path === '/' || path === '/app' || path === '/app/';
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createWebServer();
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.info(`P2Sharer web server ready on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

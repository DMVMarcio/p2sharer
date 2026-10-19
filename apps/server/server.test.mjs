import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createWebServer } from './server.mjs';

test('production host serves landing/app, public API and immutable assets without exposing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2sharer-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'assets', 'fixture.js'), 'export const ready = true;');
  const server = createWebServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = path => new Promise((resolve, reject) => {
    request(base + path, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject).end();
  });
  try {
    for (const path of ['/', '/app', '/app/']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200); assert.match(await response.text(), /id="root"/);
      assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(await (await fetch(base + '/api/health')).json(), { status: 'ok' });
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.runtime, 'web'); assert.match(config.downloadsUrl, /^https:\/\/github.com\//);
    const redirect = await fetch(base + '/api/download', { redirect: 'manual' });
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), config.downloadsUrl);
    const asset = await fetch(base + '/assets/fixture.js');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405);
    for (const path of ['/api/missing', '/assets/missing.js', '/package.json', '/app/missing']) assert.equal((await fetch(base + path)).status, 404);
    for (const path of ['/%2e%2e%2fpackage.json', '/%5c..%5cpackage.json', '/.env', '/%00', '/%invalid']) assert.equal(await raw(path), 400);
    const head = await fetch(base + '/app', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

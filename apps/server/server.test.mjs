import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createWebServer } from './server.mjs';
import { releaseDownloads } from './downloads.mjs';

test('production host serves landing/app, public API and immutable assets without exposing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2sharer-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
  await writeFile(join(root, 'assets', 'fixture.js'), 'export const ready = true;');
  const catalog = releaseDownloads(null);
  const server = await createWebServer({ root, downloads: async () => catalog });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = path => new Promise((resolve, reject) => {
    request(base + path, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject).end();
  });
  try {
    for (const path of ['/', '/app', '/app/', '/download', '/app/' + 'a'.repeat(32)]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200); assert.match(await response.text(), /id="root"/);
      assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(await (await fetch(base + '/api/health')).json(), { status: 'ok' });
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.runtime, 'web'); assert.match(config.downloadsUrl, /^https:\/\/github.com\//);
    assert.deepEqual(await (await fetch(base + '/api/downloads')).json(), catalog);
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

test('download catalog advertises only existing stable assets from the official repository', () => {
  const names = ['P2Sharer_1.4.4_x64-setup.exe', 'P2Sharer_1.4.4_x64-setup.msi', 'P2Sharer_1.4.4_x64-portable.exe'];
  const release = { tag_name: 'v1.4.4', draft: false, prerelease: false, assets: names.map(name => ({
    name, size: 1024, state: 'uploaded', browser_download_url: `https://github.com/DMVMarcio/p2sharer/releases/download/v1.4.4/${name}`,
  })) };
  assert.deepEqual(releaseDownloads(release).platforms[0].artifacts.map(item => item.id), ['installer', 'msi', 'portable']);
  assert.equal(releaseDownloads({ ...release, draft: true }).platforms[0].artifacts.length, 0);
  assert.equal(releaseDownloads({ ...release, prerelease: true }).platforms[0].artifacts.length, 0);
  release.assets[0].browser_download_url = 'https://example.com/untrusted.exe';
  release.assets[1].size = 0;
  assert.deepEqual(releaseDownloads(release).platforms[0].artifacts.map(item => item.id), ['portable']);
  assert.equal(releaseDownloads(release).platforms[1].artifacts.length, 0);
  assert.equal(releaseDownloads(null).version, null);
});

test('API supports the configured website origin, preflight and origin isolation', async () => {
  const server = await createWebServer({ apiAllowedOrigins: ['https://site.example'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  try {
    const allowed = await fetch(url, { headers: { Origin: 'https://site.example' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://site.example');
    assert.equal(allowed.headers.get('vary'), 'Origin');
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://site.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
    const denied = await fetch(url, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

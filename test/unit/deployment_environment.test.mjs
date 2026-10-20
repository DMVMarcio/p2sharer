import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceEnvironment, deploymentSettings, publicEnvironment } from '../../tools/environment.mjs';

test('environment files use shared root, mode/local precedence and external overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2sharer-env-'));
  try {
    for (const [name, value] of [['.env', 'BACKEND_PORT=3100\nSERVER_ONLY=fixture\n'], ['.env.local', 'BACKEND_PORT=3200\n'], ['.env.production', 'BACKEND_PORT=3300\n'], ['.env.production.local', 'BACKEND_PORT=3400\n']]) await writeFile(join(root, name), value);
    assert.equal(loadWorkspaceEnvironment('development', { root, environment: {} }).BACKEND_PORT, '3200');
    assert.equal(loadWorkspaceEnvironment('production', { root, environment: {} }).BACKEND_PORT, '3400');
    const env = loadWorkspaceEnvironment('production', { root, environment: { BACKEND_PORT: '3500' } });
    assert.equal(deploymentSettings(env, 'production').backendPort, 3500);
    assert.equal(Object.keys(publicEnvironment(deploymentSettings(env, 'production'))).length, 3);
    assert.ok(!JSON.stringify(publicEnvironment(deploymentSettings(env, 'production'))).includes('SERVER_ONLY'));
    assert.throws(() => loadWorkspaceEnvironment('../outside', { root }), /mode/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('custom local backend port drives API and MQTT URLs while production supports separate hosts', () => {
  const local = deploymentSettings({ BACKEND_PORT: '4317', WEB_DEV_PORT: '4318' }, 'development');
  assert.equal(local.apiUrl, 'http://127.0.0.1:4317');
  assert.equal(local.brokerUrl, 'ws://127.0.0.1:4317/mqtt');
  assert.equal(local.siteUrl, 'http://localhost:4318');
  assert.ok(local.apiAllowedOrigins.includes('http://127.0.0.1:4318'));
  const remote = deploymentSettings({ VITE_PUBLIC_SITE_URL: 'https://site.example', VITE_PUBLIC_API_URL: 'https://api.example', VITE_PUBLIC_BROKER_URL: 'wss://broker.example/signaling' }, 'production');
  assert.equal(remote.brokerUrl, 'wss://broker.example/signaling');
  assert.ok(remote.apiAllowedOrigins.includes('https://site.example'));
  assert.ok(remote.brokerAllowedOrigins.includes('http://tauri.localhost'));
  assert.equal(deploymentSettings({ PORT: '4444' }, 'production').backendPort, 4444);
  for (const env of [{ BACKEND_PORT: '0' }, { WEB_DEV_PORT: 'bad' }, { VITE_PUBLIC_API_URL: 'https://api.example/path' }, { VITE_PUBLIC_BROKER_URL: 'ws://remote.example/mqtt' }]) assert.throws(() => deploymentSettings(env, 'production'));
});

test('compiled clients use independent API and broker hosts while room links retain the site origin', async () => {
  const settings = deploymentSettings({ VITE_PUBLIC_SITE_URL: 'https://site.example', VITE_PUBLIC_API_URL: 'https://api.example', VITE_PUBLIC_BROKER_URL: 'wss://signal.example/mqtt' }, 'production');
  const bundled = await build({ entryPoints: ['src/platform/website.ts'], write: false, bundle: true, format: 'esm', platform: 'node', define: publicEnvironment(settings) });
  const client = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const prior = globalThis.window;
  globalThis.window = { location: { origin: 'https://site.example' } };
  try {
    assert.equal(client.apiUrl('/api/downloads'), 'https://api.example/api/downloads');
    assert.equal(client.signalingBrokerUrl(), 'wss://signal.example/mqtt');
    assert.equal(client.websiteUrl('/download'), 'https://site.example/download');
    window.__TAURI_INTERNALS__ = {};
    assert.equal(client.websiteUrl('/app'), 'https://site.example/app');
  } finally { globalThis.window = prior; }
});

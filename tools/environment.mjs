import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

/** Match Vite's file precedence; externally supplied environment variables always win. */
export function loadWorkspaceEnvironment(mode, { root = workspaceRoot, environment = process.env } = {}) {
  if (typeof mode !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(mode)) throw new Error('Invalid environment mode');
  const result = {};
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    try { Object.assign(result, parseEnv(readFileSync(resolve(root, name), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...result, ...environment };
}

function port(value, fallback, name) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid ${name}`);
  return number;
}
function origin(value, name) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Invalid ${name}: expected an HTTP(S) origin`);
  return url.origin;
}
function brokerAddress(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('Invalid VITE_PUBLIC_BROKER_URL');
  return url.href;
}
const desktopOrigins = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];

/** Public addresses are compiled into clients; listening addresses remain server-only. */
export function deploymentSettings(env, mode) {
  const development = mode !== 'production';
  const backendPort = port(env.BACKEND_PORT || env.PORT, 3000, 'BACKEND_PORT');
  const webPort = port(env.WEB_DEV_PORT, 1422, 'WEB_DEV_PORT');
  const siteUrl = origin(env.VITE_PUBLIC_SITE_URL || (development ? `http://localhost:${webPort}` : 'https://p2sharer.com'), 'VITE_PUBLIC_SITE_URL');
  const apiUrl = origin(env.VITE_PUBLIC_API_URL || (development ? `http://127.0.0.1:${backendPort}` : 'https://api.p2sharer.com'), 'VITE_PUBLIC_API_URL');
  const brokerUrl = brokerAddress(env.VITE_PUBLIC_BROKER_URL || `${apiUrl.replace(/^http/, 'ws')}/mqtt`);
  const origins = [...new Set([siteUrl, apiUrl, ...desktopOrigins, 'http://localhost:1420', ...(development ? [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`] : [])])];
  const list = (value, fallback) => value ? value.split(',').map(item => item.trim()).filter(Boolean).map(item => desktopOrigins.includes(item) ? item : origin(item, 'allowed origin')) : fallback;
  const host = env.BACKEND_HOST || env.HOST || '127.0.0.1';
  if (!host.trim() || /[\s/]/.test(host)) throw new Error('Invalid BACKEND_HOST');
  if (env.BROKER_TRUST_PROXY && !['0', '1'].includes(env.BROKER_TRUST_PROXY)) throw new Error('Invalid BROKER_TRUST_PROXY');
  return { backendPort, webPort, host, siteUrl, apiUrl, brokerUrl,
    apiAllowedOrigins: list(env.API_ALLOWED_ORIGINS, origins),
    brokerAllowedOrigins: list(env.BROKER_ALLOWED_ORIGINS, origins),
    trustProxy: env.BROKER_TRUST_PROXY === '1' };
}

export function publicEnvironment(settings) {
  return Object.fromEntries(Object.entries({ VITE_PUBLIC_SITE_URL: settings.siteUrl, VITE_PUBLIC_API_URL: settings.apiUrl,
    VITE_PUBLIC_BROKER_URL: settings.brokerUrl }).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]));
}

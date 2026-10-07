import { invoke } from '@tauri-apps/api/core';
import type { RootOptions } from 'react-dom/client';

let isLoggerInitialized = false;
const consoleOutput = { log: console.log.bind(console), info: console.info.bind(console),
  warn: console.warn.bind(console), error: console.error.bind(console) };

/** Preserve native error fields, nested causes and circular objects without losing the rest of a diagnostic. */
export function formatLogValue(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'function' ? `[Function: ${value.name || 'anonymous'}]` : String(value);
  }
  if (seen.has(value)) return '[Circular]';
  if (depth > 5) return '[Depth limit]';
  seen.add(value);
  try {
    if (value instanceof Error || ('message' in value && 'name' in value)) {
      const error = value as Error & { constraint?: string; code?: unknown; cause?: unknown };
      return `[${error.name || 'Error'}: ${error.message || ''}]` +
        (error.constraint ? `\n  Constraint: ${error.constraint}` : '') +
        (error.code !== undefined ? `\n  Code: ${String(error.code)}` : '') +
        (error.stack ? `\n  Stack: ${error.stack}` : '') +
        (error.cause !== undefined ? `\n  Cause: ${formatLogValue(error.cause, depth + 1, seen)}` : '');
    }
    const entries = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${formatLogValue(entry, depth + 1, seen)}`);
    return Array.isArray(value) ? `[${entries.map((entry) => entry.slice(entry.indexOf(': ') + 2)).join(', ')}]` : `{ ${entries.join(', ')} }`;
  } catch { return '[Unserializable object]'; }
  finally { seen.delete(value); }
}

export function logDiagnostic(level: 'INFO' | 'WARN' | 'ERROR', context: string, message: string, details?: unknown): void {
  const formatted = `${message}${details === undefined ? '' : ` ${formatLogValue(details)}`}`;
  // Logging must never create a second unhandled error when IPC is unavailable.
  try { void invoke('write_frontend_log', { level, message: formatted, context }).catch(() => {}); }
  catch { /* Browser-only development or a closing native host. */ }
}

export const reactErrorHandlers: Pick<RootOptions, 'onCaughtError' | 'onUncaughtError' | 'onRecoverableError'> = {
  onCaughtError: (error, info) => {
    consoleOutput.error('[React] Error caught by an error boundary:', error, info);
    logDiagnostic('ERROR', 'react.caught', 'React error boundary caught an error', { error, componentStack: info.componentStack });
  },
  onUncaughtError: (error, info) => {
    consoleOutput.error('[React] Uncaught render/lifecycle error:', error, info);
    logDiagnostic('ERROR', 'react.uncaught', 'React render/lifecycle failed', { error, componentStack: info.componentStack });
  },
  onRecoverableError: (error, info) => {
    consoleOutput.warn('[React] Recovered render error:', error, info);
    logDiagnostic('WARN', 'react.recovered', 'React recovered from an error', { error, componentStack: info.componentStack });
  },
};

function persistedInfo(message: unknown): boolean {
  return typeof message === 'string' && [
    '[P2P] Joining', '[P2P] Direct WebRTC peer', '[P2P] Peer left', '[SignalingManager] Joining',
    '[RoomService]', '[NativeVideoBridge]', '[Video]',
  ].some((prefix) => message.startsWith(prefix));
}

export function initFrontendLogger(): void {
  if (isLoggerInitialized) return;
  isLoggerInitialized = true;
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    console[method] = (...args: unknown[]) => {
      consoleOutput[method](...args);
      if (method === 'log' || method === 'info') { if (!persistedInfo(args[0])) return; }
      logDiagnostic(method === 'warn' ? 'WARN' : method === 'error' ? 'ERROR' : 'INFO', 'frontend',
        args.map((argument) => formatLogValue(argument)).join(' '));
    };
  }
  window.addEventListener('error', (event) => {
    logDiagnostic('ERROR', 'window.error', 'Uncaught JavaScript exception', {
      error: event.error ?? event.message, filename: event.filename, line: event.lineno, column: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    logDiagnostic('ERROR', 'window.unhandledrejection', 'Unhandled promise rejection', event.reason);
  });
  logDiagnostic('INFO', 'frontend.startup', 'Frontend diagnostics ready', {
    surface: new URLSearchParams(window.location.search).has('pointerOverlay') ? 'pointer-overlay' :
      new URLSearchParams(window.location.search).has('pip') ? 'pip' : 'main', userAgent: navigator.userAgent,
  });
}

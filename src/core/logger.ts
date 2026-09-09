import { invoke } from '@tauri-apps/api/core';

export function initFrontendLogger(): void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const formatValue = (val: unknown, depth = 0): string => {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'symbol' || typeof val === 'bigint') {
      return String(val);
    }
    if (typeof val === 'function') {
      return `[Function: ${val.name || 'anonymous'}]`;
    }

    if (val instanceof Error || (typeof val === 'object' && val !== null && 'message' in val && 'name' in val)) {
      const err = val as Error;
      const name = err.name || 'Error';
      const msg = err.message || '';
      const stack = err.stack ? `\n  Stack: ${err.stack}` : '';
      const cause = (err as { cause?: unknown }).cause ? `\n  Cause: ${formatValue((err as { cause?: unknown }).cause, depth + 1)}` : '';
      return `[${name}: ${msg}]${stack}${cause}`;
    }

    if (typeof val === 'object' && val !== null) {
      if (depth > 3) return '[Object]';
      try {
        return JSON.stringify(val, null, 2);
      } catch {
        return String(val);
      }
    }

    return String(val);
  };

  const formatArgs = (args: unknown[]) => args.map((a) => formatValue(a)).join(' ');

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    invoke('write_frontend_log', {
      level: 'INFO',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    invoke('write_frontend_log', {
      level: 'WARN',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: formatArgs(args),
      context: 'frontend',
    }).catch(() => {});
  };

  window.addEventListener('error', (event) => {
    const errorDetails = event.error
      ? formatValue(event.error)
      : `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: `Uncaught Exception: ${errorDetails}`,
      context: 'window.onerror',
    }).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason ? formatValue(event.reason) : 'Unknown promise rejection';
    invoke('write_frontend_log', {
      level: 'ERROR',
      message: `Unhandled Promise Rejection: ${reason}`,
      context: 'unhandledrejection',
    }).catch(() => {});
  });
}

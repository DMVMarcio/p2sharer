import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

/** Keep native commands in the desktop host; load browser implementations on demand. */
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) return nativeInvoke(command, args, options);
  const { invokeBrowser } = await import('./web_commands.ts');
  return invokeBrowser(command, args, { headers: Object.fromEntries(new Headers(options?.headers).entries()) }) as Promise<T>;
}

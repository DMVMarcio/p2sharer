import { useState, useEffect } from 'react';
import { ToastManager, type ToastItem, type ToastShowOptions, type ToastType } from '../core/ui/toast_manager.ts';
export type { ToastAction, ToastItem, ToastShowOptions, ToastType } from '../core/ui/toast_manager.ts';
export const toastManager = new ToastManager();
export function showToast(message: string, durationMs = 3500, type: ToastType = 'info', options?: ToastShowOptions): void {
  toastManager.show(message, durationMs, type, options);
}
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => toastManager.subscribe(setToasts), []);
  return { toasts, showToast, removeToast: (id: string) => toastManager.remove(id) };
}

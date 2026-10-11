import { useState, useEffect } from 'react';
import { ToastManager, type ToastItem, type ToastType } from '../core/toast_manager.ts';
export type { ToastItem, ToastType } from '../core/toast_manager.ts';
export const toastManager = new ToastManager();
export function showToast(message: string, durationMs = 3500, type: ToastType = 'info'): void {
  toastManager.show(message, durationMs, type);
}
export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  useEffect(() => toastManager.subscribe(setToasts), []);
  return { toasts, showToast, removeToast: (id: string) => toastManager.remove(id) };
}

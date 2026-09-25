import { useState, useEffect } from 'react';

export interface ToastItem {
  id: string;
  message: string;
}

type ToastListener = (toasts: ToastItem[]) => void;

class ToastManager {
  private toasts: ToastItem[] = [];
  private listeners: Set<ToastListener> = new Set();
  private nextId = 0;

  public subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    listener([...this.toasts]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const copy = [...this.toasts];
    this.listeners.forEach((listener) => listener(copy));
  }

  public show(message: string, durationMs = 3500): void {
    const id = `toast_${Date.now()}_${++this.nextId}`;
    this.toasts.push({ id, message });
    this.notify();

    setTimeout(() => {
      this.remove(id);
    }, durationMs);
  }

  public remove(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }
}

export const toastManager = new ToastManager();

export function showToast(message: string, durationMs = 3500): void {
  toastManager.show(message, durationMs);
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    return toastManager.subscribe(setToasts);
  }, []);

  return {
    toasts,
    showToast,
    removeToast: (id: string) => toastManager.remove(id),
  };
}

export type ToastType = 'info' | 'success' | 'warning' | 'error';
export interface ToastAction {
  label: string;
  onAction: () => void | Promise<void>;
}
export interface ToastShowOptions {
  action?: ToastAction;
  dedupeKey?: string;
}
export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  durationMs: number;
  paused: boolean;
  action?: ToastAction;
  dedupeKey?: string;
}
type ToastListener = (toasts: ToastItem[]) => void;

export class ToastManager {
  private toasts: ToastItem[] = [];
  private listeners = new Set<ToastListener>();
  private clocks = new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: number; remaining: number }>();
  private nextId = 0;

  subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener);
    listener([...this.toasts]);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { this.listeners.forEach(listener => listener([...this.toasts])); }
  show(message: string, durationMs = 3500, type: ToastType = 'info', options?: ToastShowOptions): void {
    const duration = Math.max(1, durationMs);
    if (options?.dedupeKey) {
      const existing = this.toasts.find(toast => toast.dedupeKey === options.dedupeKey);
      if (existing) {
        const oldClock = this.clocks.get(existing.id);
        if (oldClock) clearTimeout(oldClock.timer);
        this.toasts = this.toasts.map(toast =>
          toast.id === existing.id
            ? { ...toast, message, type, durationMs: duration, paused: false, action: options.action }
            : toast,
        );
        this.clocks.set(existing.id, {
          timer: setTimeout(() => this.remove(existing.id), duration),
          deadline: Date.now() + duration,
          remaining: duration,
        });
        this.notify();
        return;
      }
    }
    const id = `toast_${++this.nextId}`;
    this.toasts.push({
      id,
      message,
      type,
      durationMs: duration,
      paused: false,
      action: options?.action,
      dedupeKey: options?.dedupeKey,
    });
    this.clocks.set(id, { timer: setTimeout(() => this.remove(id), duration), deadline: Date.now() + duration, remaining: duration });
    this.notify();
  }
  pause(id: string): void {
    const item = this.toasts.find(toast => toast.id === id);
    const clock = this.clocks.get(id);
    if (!item || !clock || item.paused) return;
    clearTimeout(clock.timer);
    clock.remaining = Math.max(1, clock.deadline - Date.now());
    this.toasts = this.toasts.map(toast => toast.id === id ? { ...toast, paused: true } : toast);
    this.notify();
  }
  resume(id: string): void {
    const item = this.toasts.find(toast => toast.id === id);
    const clock = this.clocks.get(id);
    if (!item?.paused || !clock) return;
    clock.deadline = Date.now() + clock.remaining;
    clock.timer = setTimeout(() => this.remove(id), clock.remaining);
    this.toasts = this.toasts.map(toast => toast.id === id ? { ...toast, paused: false } : toast);
    this.notify();
  }
  remove(id: string): void {
    const clock = this.clocks.get(id);
    if (!clock) return;
    clearTimeout(clock.timer);
    this.clocks.delete(id);
    this.toasts = this.toasts.filter(toast => toast.id !== id);
    this.notify();
  }
}

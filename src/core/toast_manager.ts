export type ToastType = 'info' | 'success' | 'warning' | 'error';
export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  durationMs: number;
  paused: boolean;
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
  show(message: string, durationMs = 3500, type: ToastType = 'info'): void {
    const id = `toast_${++this.nextId}`;
    const duration = Math.max(1, durationMs);
    this.toasts.push({ id, message, type, durationMs: duration, paused: false });
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

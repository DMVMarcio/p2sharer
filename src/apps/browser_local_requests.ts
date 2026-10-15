/** Device-local RPCs never enter room messages or snapshots. */
export class BrowserLocalRequests {
  private pending = new Map<string, { resolve(value?: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private emit: (payload: unknown) => void;
  private timeout: number;
  constructor(emit: (payload: unknown) => void, timeout = 120_000) { this.emit = emit; this.timeout = timeout; }
  request<T = void>(action: string, args: unknown[] = []): Promise<T> {
    if (this.pending.size >= 32) return Promise.reject(new Error('Browser is busy'));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser operation timed out')); }, this.timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.emit({ type: 'browser-local', id, action, args });
    });
  }
  result(id: string, error?: string, value?: unknown): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error)); else pending.resolve(value);
  }
  destroy(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed')); }
    this.pending.clear();
  }
}

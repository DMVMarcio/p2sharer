/** Device-local RPCs never enter room messages or snapshots. */
export class BrowserLocalRequests {
  private pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private emit: (payload: unknown) => void;
  constructor(emit: (payload: unknown) => void) { this.emit = emit; }
  request(action: string, args: unknown[] = []): Promise<void> {
    if (this.pending.size >= 32) return Promise.reject(new Error('Browser is busy'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser operation timed out')); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.emit({ type: 'browser-local', id, action, args });
    });
  }
  result(id: string, error?: string): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error)); else pending.resolve();
  }
  destroy(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed')); }
    this.pending.clear();
  }
}

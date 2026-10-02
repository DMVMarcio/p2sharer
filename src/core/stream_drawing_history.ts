import type { StreamPointerVisual } from './stream_pointer.ts';

interface DrawingAction { removed: StreamPointerVisual[]; added: StreamPointerVisual[] }
interface AuthorHistory { undo: DrawingAction[]; redo: DrawingAction[] }

/** Broadcaster-owned history: callers supply the authenticated author, never a packet claim. */
export class StreamDrawingHistory {
  private authors = new Map<string, AuthorHistory>();
  record(peerId: string, action: DrawingAction, limit: number) {
    const history = this.authors.get(peerId) ?? { undo: [], redo: [] };
    history.undo.push(action); history.redo = [];
    if (history.undo.length > limit) history.undo.splice(0, history.undo.length - limit);
    this.authors.set(peerId, history);
  }
  step(peerId: string, direction: 'undo' | 'redo'): DrawingAction | null {
    const history = this.authors.get(peerId);
    const action = history?.[direction].pop();
    if (!history || !action) return null;
    history[direction === 'undo' ? 'redo' : 'undo'].push(action);
    return direction === 'undo' ? { removed: action.added, added: action.removed } : action;
  }
  trim(limit: number) {
    for (const history of this.authors.values()) {
      for (const stack of [history.undo, history.redo]) if (stack.length > limit) stack.splice(0, stack.length - limit);
    }
  }
  discard(id: string) {
    for (const history of this.authors.values()) {
      for (const direction of ['undo', 'redo'] as const) history[direction] = history[direction].map(action => ({
        added: action.added.filter(v => v.id !== id), removed: action.removed.filter(v => v.id !== id),
      })).filter(action => action.added.length || action.removed.length);
    }
  }
  forget(peerId: string) { this.authors.delete(peerId); }
  clear() { this.authors.clear(); }
  state() { return [...this.authors].map(([peerId, history]) => ({ peerId, undo: history.undo.length, redo: history.redo.length })); }
}

import { localStreamPointerVisuals, type StreamPointerState, type StreamPointerVisual } from '../core/stream_pointer.ts';

export interface StreamPointerScene { visuals: StreamPointerVisual[]; localPeerId: string; name: string; color: string; drawingAllowed?: boolean }
const EMPTY: StreamPointerScene = { visuals: [], localPeerId: '', name: '', color: '' };

class StreamPointerView {
  private scenes = new Map<string, StreamPointerScene>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (peerId: string) => this.scenes.get(peerId) ?? EMPTY;
  set(peerId: string, state: StreamPointerState, identity: Omit<StreamPointerScene, 'visuals'>) {
    this.scenes.set(peerId, { ...identity, drawingAllowed: state.drawingAllowed, visuals: localStreamPointerVisuals(state) });
    this.listeners.forEach((listener) => listener());
  }
  state(peerId: string): StreamPointerState {
    const sentAt = Date.now();
    return { kind: 'state', sentAt, drawingAllowed: this.get(peerId).drawingAllowed, visuals: this.get(peerId).visuals.filter((v) => v.expires > sentAt) };
  }
  clear() { this.scenes.clear(); this.listeners.forEach((listener) => listener()); }
}

export const streamPointerView = new StreamPointerView();

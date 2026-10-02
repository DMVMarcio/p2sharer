/**
 * Complete headless DOM, Web Audio, and WebRTC mock for P2Sharer E2E tests.
 * Enables testing DOM reconciliation, Singleton AudioContext invariants, and media streams.
 */

export class MockClassList {
  private classes: Set<string> = new Set();

  constructor(initial: string = '') {
    if (initial) {
      initial.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    }
  }

  public add(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.add(t));
  }

  public remove(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.delete(t));
  }

  public contains(token: string): boolean {
    return this.classes.has(token);
  }

  public toggle(token: string, force?: boolean): boolean {
    if (force !== undefined) {
      if (force) this.classes.add(token);
      else this.classes.delete(token);
      return force;
    }
    if (this.classes.has(token)) {
      this.classes.delete(token);
      return false;
    } else {
      this.classes.add(token);
      return true;
    }
  }

  public toString(): string {
    return Array.from(this.classes).join(' ');
  }
}

export class MockElement {
  public tagName: string;
  public id: string = '';
  public classList: MockClassList;
  public children: MockElement[] = [];
  public parentNode: MockElement | null = null;
  public textContent: string = '';
  private _innerHTML: string = '';
  public attributes: Map<string, string> = new Map();
  public style: Record<string, any> & {
    setProperty: (name: string, value: string) => void;
    getPropertyValue: (name: string) => string;
  };
  public dataset: Record<string, string> = {};
  public title: string = '';
  public onclick: ((evt: any) => void) | null = null;
  public oninput: ((evt: any) => void) | null = null;
  public value: string = '';
  private eventListeners: Map<string, Array<(evt: any) => void>> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList();
    this.style = Object.assign({}, {
      setProperty: (name: string, value: string) => {
        this.style[name] = String(value);
      },
      getPropertyValue: (name: string) => {
        return this.style[name] || '';
      },
    });
  }

  public addEventListener(type: string, listener: (evt: any) => void): void {
    const list = this.eventListeners.get(type) || [];
    list.push(listener);
    this.eventListeners.set(type, list);
  }

  public removeEventListener(type: string, listener: (evt: any) => void): void {
    const list = this.eventListeners.get(type);
    if (list) {
      const idx = list.indexOf(listener);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  public dispatchEvent(event: any): boolean {
    if (!event.target) event.target = this;
    if (!event.currentTarget) event.currentTarget = this;
    if (!event.stopPropagation) event.stopPropagation = () => {};
    if (!event.preventDefault) event.preventDefault = () => {};

    const listeners = this.eventListeners.get(event.type) || [];
    listeners.forEach((fn) => fn(event));

    if (event.type === 'click' && this.onclick) {
      this.onclick(event);
    }
    if (event.type === 'input' && this.oninput) {
      this.oninput(event);
    }
    return true;
  }

  public click(): void {
    this.dispatchEvent({
      type: 'click',
      target: this,
      currentTarget: this,
      stopPropagation: () => {},
      preventDefault: () => {},
    });
  }

  get className(): string {
    return this.classList.toString();
  }

  set className(val: string) {
    this.classList = new MockClassList(val);
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    if (val && val.trim()) {
      const parsed = parseHtmlFragment(val);
      parsed.forEach((c) => this.appendChild(c));
    }
  }

  get parentElement(): MockElement | null {
    return this.parentNode;
  }

  public remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  public insertBefore<T extends MockElement>(newChild: T, refChild: MockElement | null): T {
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    newChild.parentNode = this;
    if (!refChild) {
      this.children.push(newChild);
    } else {
      const idx = this.children.indexOf(refChild);
      if (idx !== -1) {
        this.children.splice(idx, 0, newChild);
      } else {
        this.children.push(newChild);
      }
    }
    return newChild;
  }

  public appendChild<T extends MockElement>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public removeChild<T extends MockElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        return child;
      }
      const deepMatch = child.querySelector(selector);
      if (deepMatch) return deepMatch;
    }
    return null;
  }

  public querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (matchesSelector(child, selector)) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

function matchesSelector(el: MockElement, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed.startsWith('#') && el.id === trimmed.slice(1)) return true;
  if (trimmed.startsWith('.') && el.classList.contains(trimmed.slice(1))) return true;
  if (el.tagName.toLowerCase() === trimmed.toLowerCase()) return true;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    const eqIdx = inner.indexOf('=');
    if (eqIdx === -1) {
      return el.attributes.has(inner);
    }
    const attrName = inner.slice(0, eqIdx).trim();
    let expectedVal = inner.slice(eqIdx + 1).trim();
    if ((expectedVal.startsWith('"') && expectedVal.endsWith('"')) || (expectedVal.startsWith("'") && expectedVal.endsWith("'"))) {
      expectedVal = expectedVal.slice(1, -1);
    }
    return el.attributes.get(attrName) === expectedVal;
  }
  return false;
}

function parseHtmlFragment(html: string): MockElement[] {
  const root = new MockElement('FRAGMENT');
  const stack: MockElement[] = [root];
  const tagRegex = /<(?:\/([a-zA-Z0-9-]+)|([a-zA-Z0-9-]+)([^>]*)(\/)?)>|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    const [_, closeTag, openTag, attrsStr, selfClose, text] = match;
    const currentParent = stack[stack.length - 1]!;

    if (text) {
      const trimmed = text.trim();
      if (trimmed) {
        if (!currentParent.textContent) {
          currentParent.textContent = trimmed;
        } else {
          currentParent.textContent += ' ' + trimmed;
        }
      }
    } else if (openTag) {
      const el = new MockElement(openTag);
      if (attrsStr) {
        const attrRegex = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let attrMatch: RegExpExecArray | null;
        while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
          const attrName = attrMatch[1]!;
          const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
          if (attrName === 'class') {
            el.className = attrVal;
          } else if (attrName === 'id') {
            el.id = attrVal;
          } else if (attrName === 'title') {
            el.title = attrVal;
          } else {
            el.setAttribute(attrName, attrVal);
          }
        }
      }
      currentParent.appendChild(el);
      const isVoid = Boolean(selfClose) || ['IMG', 'INPUT', 'BR', 'HR', 'PATH', 'CIRCLE', 'LINE', 'POLYGON'].includes(el.tagName);
      if (!isVoid) {
        stack.push(el);
      }
    } else if (closeTag) {
      if (stack.length > 1 && stack[stack.length - 1]!.tagName.toLowerCase() === closeTag.toLowerCase()) {
        stack.pop();
      }
    }
  }

  const children = [...root.children];
  children.forEach((c) => (c.parentNode = null));
  root.children = [];
  return children;
}

export class MockVideoElement extends MockElement {
  public srcObject: MockMediaStream | null = null;
  public paused: boolean = true;
  public muted: boolean = false;
  public autoplay: boolean = false;
  public playsInline: boolean = false;
  public playCount: number = 0;
  public pauseCount: number = 0;
  public loadCount: number = 0;

  constructor(tag = 'VIDEO') {
    super(tag);
  }

  public async play(): Promise<void> {
    this.paused = false;
    this.playCount++;
  }

  public pause(): void {
    this.paused = true;
    this.pauseCount++;
  }

  public load(): void {
    this.loadCount++;
  }
}

export class MockCanvasElement extends MockElement {
  public width: number = 1920;
  public height: number = 1080;

  constructor() {
    super('CANVAS');
  }

  public getContext(contextType: string): any {
    if (contextType === 'bitmaprenderer') {
      return {
        transferFromImageBitmap: () => {},
      };
    }
    if (contextType === '2d') {
      return {
        imageSmoothingEnabled: false,
        fillStyle: '',
        fillRect: () => {},
        drawImage: () => {},
      };
    }
    return null;
  }

  public captureStream(fps: number): MockMediaStream {
    const stream = new MockMediaStream();
    const track = new MockMediaStreamTrack('video', `canvas-track-${fps}fps`);
    stream.addTrack(track);
    return stream;
  }
}

export class MockMediaStreamTrack {
  public kind: 'video' | 'audio';
  public id: string;
  public enabled: boolean = true;
  public readyState: 'live' | 'ended' = 'live';
  public contentHint: string = '';
  public frameRequests: number = 0;
  public stopCount: number = 0;

  constructor(kind: 'video' | 'audio', id: string = `track-${Math.random()}`) {
    this.kind = kind;
    this.id = id;
  }

  public stop(): void {
    this.readyState = 'ended';
    this.enabled = false;
    this.stopCount++;
  }

  public requestFrame(): void {
    this.frameRequests++;
  }
}

export class MockMediaStream {
  public id: string;
  private tracks: MockMediaStreamTrack[] = [];

  constructor(id: string = `stream-${Math.random()}`) {
    this.id = id;
  }

  public getTracks(): MockMediaStreamTrack[] {
    return [...this.tracks];
  }

  public getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  public getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  public addTrack(track: MockMediaStreamTrack): void {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
    }
  }

  public removeTrack(track: MockMediaStreamTrack): void {
    const idx = this.tracks.indexOf(track);
    if (idx !== -1) {
      this.tracks.splice(idx, 1);
    }
  }
}

export class MockGainNode {
  public gain = { value: 1.0 };
  public connectedTo: any = null;

  public connect(dest: any): void {
    this.connectedTo = dest;
  }

  public disconnect(): void {
    this.connectedTo = null;
  }
}

export class MockAudioBuffer {
  public numberOfChannels: number;
  public length: number;
  public sampleRate: number;
  public duration: number;
  private channelData: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channelData = Array.from({ length: channels }, () => new Float32Array(length));
  }

  public getChannelData(channel: number): Float32Array {
    return this.channelData[channel] || new Float32Array(this.length);
  }
}

export class MockAudioBufferSourceNode {
  public buffer: MockAudioBuffer | null = null;
  public startedAt: number | null = null;
  public stoppedAt: number | null = null;
  public connectedTo: any = null;

  public connect(dest: any): void {
    this.connectedTo = dest;
  }

  public disconnect(): void {
    this.connectedTo = null;
  }

  public start(when: number = 0): void {
    this.startedAt = when;
  }

  public stop(when: number = 0): void {
    this.stoppedAt = when;
  }
}

export class MockMediaStreamAudioDestinationNode {
  public stream: MockMediaStream;

  constructor() {
    this.stream = new MockMediaStream('webaudio-dest-stream');
    this.stream.addTrack(new MockMediaStreamTrack('audio', 'webaudio-dest-track'));
  }
}

export class MockAudioContext {
  public static instanceCount: number = 0;
  public state: 'running' | 'suspended' | 'closed' = 'running';
  public sampleRate: number = 48000;
  public currentTime: number = 0;
  public destination: any = {};

  constructor(options?: { sampleRate?: number }) {
    MockAudioContext.instanceCount++;
    if (options?.sampleRate) {
      this.sampleRate = options.sampleRate;
    }
  }

  public async resume(): Promise<void> {
    this.state = 'running';
  }

  public async close(): Promise<void> {
    this.state = 'closed';
  }

  public createGain(): MockGainNode {
    return new MockGainNode();
  }

  public createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(channels, length, sampleRate);
  }

  public createBufferSource(): MockAudioBufferSourceNode {
    return new MockAudioBufferSourceNode();
  }

  public createMediaStreamDestination(): MockMediaStreamAudioDestinationNode {
    return new MockMediaStreamAudioDestinationNode();
  }

  public createMediaStreamSource(stream: MockMediaStream): any {
    return {
      stream,
      connect: (_dest: any) => {},
      disconnect: () => {},
    };
  }
}

export class MockDocument {
  public elementsById: Map<string, MockElement> = new Map();
  public body: MockElement = new MockElement('BODY');

  public createElement(tagName: string): MockElement {
    const tag = tagName.toUpperCase();
    if (tag === 'VIDEO') return new MockVideoElement();
    if (tag === 'AUDIO') return new MockVideoElement('AUDIO');
    if (tag === 'CANVAS') return new MockCanvasElement();
    return new MockElement(tag);
  }

  public getElementById(id: string): MockElement | null {
    return this.elementsById.get(id) || null;
  }

  public registerElement(id: string, el: MockElement): void {
    el.id = id;
    this.elementsById.set(id, el);
  }
}

export interface DOMEnvironment {
  document: MockDocument;
  cleanup: () => void;
}

export function setupTestDOM(): DOMEnvironment {
  const originalDocument = (globalThis as any).document;
  const originalWindow = (globalThis as any).window;
  const originalAudioContext = (globalThis as any).AudioContext;
  const originalMediaStream = (globalThis as any).MediaStream;

  const doc = new MockDocument();
  (globalThis as any).document = doc;
  (globalThis as any).window = globalThis;
  (globalThis as any).AudioContext = MockAudioContext;
  (globalThis as any).MediaStream = MockMediaStream;
  (globalThis as any).HTMLVideoElement = MockVideoElement;

  MockAudioContext.instanceCount = 0;

  return {
    document: doc,
    cleanup: () => {
      (globalThis as any).document = originalDocument;
      (globalThis as any).window = originalWindow;
      (globalThis as any).AudioContext = originalAudioContext;
      (globalThis as any).MediaStream = originalMediaStream;
    },
  };
}

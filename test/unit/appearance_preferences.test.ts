import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectHardwareAcceleration } from '../../src/core/hardware_acceleration.ts';
import { isReducedMotion, applyAppearanceAttributes } from '../../src/core/appearance_preferences.ts';
import { stateStore } from '../../src/core/state_store.ts';

describe('Hardware acceleration detection', () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  it('reports false when canvas getContext returns null with failIfMajorPerformanceCaveat', () => {
    globalThis.window = {} as unknown as Window & typeof globalThis;
    globalThis.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            getContext: (type: string, options?: { failIfMajorPerformanceCaveat?: boolean }) => {
              if (options?.failIfMajorPerformanceCaveat) return null;
              return {};
            },
          };
        }
        return {};
      },
    } as unknown as Document;

    const result = detectHardwareAcceleration();
    assert.equal(result, false);
  });

  it('reports false when the unmasked renderer matches a software rasterizer', () => {
    globalThis.window = {} as unknown as Window & typeof globalThis;
    globalThis.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            getContext: () => ({
              getExtension: (ext: string) => {
                if (ext === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
                if (ext === 'WEBGL_lose_context') return { loseContext: () => {} };
                return null;
              },
              getParameter: (param: number) => {
                if (param === 0x9246) return 'Google SwiftShader (Subzero Direct3D9)';
                return '';
              },
            }),
          };
        }
        return {};
      },
    } as unknown as Document;

    const result = detectHardwareAcceleration();
    assert.equal(result, false);
  });

  it('reports true when a discrete or integrated hardware GPU is available', () => {
    let lostContext = false;
    globalThis.window = {} as unknown as Window & typeof globalThis;
    globalThis.document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            getContext: () => ({
              getExtension: (ext: string) => {
                if (ext === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
                if (ext === 'WEBGL_lose_context') return { loseContext: () => { lostContext = true; } };
                return null;
              },
              getParameter: (param: number) => {
                if (param === 0x9246) return 'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11)';
                return '';
              },
            }),
          };
        }
        return {};
      },
    } as unknown as Document;

    const result = detectHardwareAcceleration();
    assert.equal(result, true);
    assert.equal(lostContext, true, 'Cleaned up WebGL context after probing');
  });
});

describe('Reduced motion and appearance attributes', () => {
  it('identifies reduced motion when animations are disabled in stateStore', () => {
    stateStore.animationsEnabled = false;
    assert.equal(isReducedMotion(), true);

    stateStore.animationsEnabled = true;
    // Without matchMedia prefers-reduced-motion reduce
    assert.equal(isReducedMotion(), false);
  });

  it('applies and removes data-reduced-motion and data-reduced-effects attributes', () => {
    const attributes = new Map<string, string>();
    const mockRoot = {
      setAttribute: (key: string, val: string) => attributes.set(key, val),
      removeAttribute: (key: string) => attributes.delete(key),
    };
    const prevDoc = globalThis.document;
    globalThis.document = { documentElement: mockRoot } as unknown as Document;

    try {
      applyAppearanceAttributes(false, false);
      assert.equal(attributes.get('data-reduced-motion'), 'true');
      assert.equal(attributes.get('data-reduced-effects'), 'true');

      applyAppearanceAttributes(true, true);
      assert.equal(attributes.has('data-reduced-motion'), false);
      assert.equal(attributes.has('data-reduced-effects'), false);

      applyAppearanceAttributes(false, true);
      assert.equal(attributes.get('data-reduced-motion'), 'true');
      assert.equal(attributes.has('data-reduced-effects'), false);
    } finally {
      globalThis.document = prevDoc;
    }
  });

  it('saves appearance preferences and notifies subscribers in StateStore', () => {
    let notified = false;
    const unsubscribe = stateStore.subscribe(() => { notified = true; });

    stateStore.saveAppearancePreferences({ animations: false, visualEffects: false });
    assert.equal(stateStore.animationsEnabled, false);
    assert.equal(stateStore.visualEffectsEnabled, false);
    assert.equal(notified, true);

    stateStore.saveAppearancePreferences({ animations: true, visualEffects: true });
    assert.equal(stateStore.animationsEnabled, true);
    assert.equal(stateStore.visualEffectsEnabled, true);

    unsubscribe();
  });

  it('restores stored preferences on loadFromStorage', () => {
    const storage = new Map<string, string>();
    storage.set('p2sharer_animations', 'false');
    storage.set('p2sharer_visual_effects', 'true');

    const prevStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    } as unknown as Storage;

    try {
      stateStore.loadFromStorage();
      assert.equal(stateStore.animationsEnabled, false);
      assert.equal(stateStore.visualEffectsEnabled, true);
    } finally {
      globalThis.localStorage = prevStorage;
    }
  });
});

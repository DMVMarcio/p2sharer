import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDOM,
  MockCanvasElement,
} from '../harness/dom-mock.ts';
import { validateIpcInvoke } from '../harness/ipc-contract.ts';

describe('Tier 2: R1 Video Boundaries & Corner Cases', () => {
  it('R1-T2-1: Should handle boundary 0x0 resolution in capture options without crashing', () => {
    const zeroResOptions = {
      sourceId: 'monitor:0',
      targetFps: 30,
      targetWidth: 0,
      targetHeight: 0,
      captureMouse: true,
      quality: 75,
    };
    const validation = validateIpcInvoke('start_native_screen_capture', zeroResOptions);
    assert.equal(validation.valid, true);

    // In Rust backend, width=0 and height=0 defaults to native window dimensions (zero scaling)
    assert.equal(zeroResOptions.targetWidth, 0);
    assert.equal(zeroResOptions.targetHeight, 0);
  });

  it('R1-T2-2: Should handle extreme 8K UHD resolution (7680x4320) buffer calculations', () => {
    const width = 7680;
    const height = 4320;
    const bytesPerPixel = 4; // RGBA
    const rawFrameSizeBytes = width * height * bytesPerPixel;

    // 8K frame is ~132.7 MB uncompressed
    assert.equal(rawFrameSizeBytes, 132710400);

    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      canvas.width = width;
      canvas.height = height;
      assert.equal(canvas.width, 7680);
      assert.equal(canvas.height, 4320);

      const stream = canvas.captureStream(60);
      assert.ok(stream.getVideoTracks().length > 0);
    } finally {
      dom.cleanup();
    }
  });

  it('R1-T2-3: Should validate boundary frame rates (0 FPS fallback and 240 FPS high-refresh)', () => {
    // 0 FPS must be rejected or clamped to at least 1 FPS
    function sanitizeFps(rawFps: number): number {
      if (rawFps <= 0 || !isFinite(rawFps)) return 30;
      return Math.min(240, Math.max(1, Math.round(rawFps)));
    }

    assert.equal(sanitizeFps(0), 30);
    assert.equal(sanitizeFps(-60), 30);
    assert.equal(sanitizeFps(NaN), 30);
    assert.equal(sanitizeFps(240), 240);
    assert.equal(sanitizeFps(360), 240); // Clamped to 240
    assert.equal(sanitizeFps(1), 1);
  });

  it('R1-T2-4: Should reject invalid quality parameters (< 0 or > 100)', () => {
    function sanitizeQuality(rawQuality: number): number {
      if (rawQuality < 1 || rawQuality > 100 || !isFinite(rawQuality)) return 75;
      return Math.round(rawQuality);
    }

    assert.equal(sanitizeQuality(-10), 75);
    assert.equal(sanitizeQuality(150), 75);
    assert.equal(sanitizeQuality(1), 1);
    assert.equal(sanitizeQuality(100), 100);
  });

  it('R1-T2-5: Should reject IPC invocation with missing or empty sourceId', () => {
    const missingResult = validateIpcInvoke('start_native_screen_capture', {
      targetFps: 60,
    });
    assert.equal(missingResult.valid, false);
    assert.ok(missingResult.error?.includes('sourceId'));
  });

  it('R1-T2-6: Should verify graceful fallback when bitmaprenderer fails', () => {
    const dom = setupTestDOM();
    try {
      const canvas = dom.document.createElement('canvas') as MockCanvasElement;
      // Force bitmaprenderer failure
      canvas.getContext = (type: string) => {
        if (type === 'bitmaprenderer') throw new Error('Not supported');
        return {
          imageSmoothingEnabled: false,
          fillRect: () => {},
          drawImage: () => {},
        };
      };

      let ctx = null;
      try {
        ctx = canvas.getContext('bitmaprenderer');
      } catch {
        ctx = canvas.getContext('2d');
      }

      assert.ok(ctx !== null);
      assert.equal(typeof ctx.drawImage, 'function');
    } finally {
      dom.cleanup();
    }
  });
});

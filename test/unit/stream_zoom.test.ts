import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  clampZoom,
  calculatePanBounds,
  clampPanOffset,
  calculateFocalZoom,
  stepZoom,
} from '../../src/components/room/zoom_utils.ts';

describe('Stream Zoom System Utilities', () => {
  describe('clampZoom', () => {
    it('returns MIN_ZOOM (1.0) when input is below 1.0 or non-numeric', () => {
      assert.equal(clampZoom(0.5), 1.0);
      assert.equal(clampZoom(0), 1.0);
      assert.equal(clampZoom(-2), 1.0);
      assert.equal(clampZoom(NaN), 1.0);
      assert.equal(clampZoom(Infinity), 1.0);
    });

    it('returns MAX_ZOOM (5.0) when input exceeds 5.0', () => {
      assert.equal(clampZoom(5.5), 5.0);
      assert.equal(clampZoom(10.0), 5.0);
      assert.equal(clampZoom(100), 5.0);
    });

    it('preserves valid zoom and rounds to 2 decimal places', () => {
      assert.equal(clampZoom(1.25), 1.25);
      assert.equal(clampZoom(2.33333), 2.33);
      assert.equal(clampZoom(4.999), 5.0);
    });
  });

  describe('calculatePanBounds', () => {
    it('returns 0 bounds when zoom <= 1.0 or container has non-positive dimensions', () => {
      assert.deepEqual(calculatePanBounds(1.0, 1920, 1080), { maxX: 0, maxY: 0 });
      assert.deepEqual(calculatePanBounds(0.8, 1920, 1080), { maxX: 0, maxY: 0 });
      assert.deepEqual(calculatePanBounds(2.0, 0, 1080), { maxX: 0, maxY: 0 });
      assert.deepEqual(calculatePanBounds(2.0, 1920, -50), { maxX: 0, maxY: 0 });
    });

    it('correctly calculates max pan bounds when scaled', () => {
      // Zoom 2x on 800x600: content width = 1600, delta = 800, max pan = 400
      const b1 = calculatePanBounds(2.0, 800, 600);
      assert.equal(b1.maxX, 400);
      assert.equal(b1.maxY, 300);

      // Zoom 3x on 1000x500: content width = 3000, delta = 2000, max pan = 1000
      const b2 = calculatePanBounds(3.0, 1000, 500);
      assert.equal(b2.maxX, 1000);
      assert.equal(b2.maxY, 500);
    });
  });

  describe('clampPanOffset', () => {
    it('resets to (0, 0) when zoom is 1.0', () => {
      const res = clampPanOffset({ x: 150, y: -200 }, 1.0, 800, 600);
      assert.deepEqual(res, { x: 0, y: 0 });
    });

    it('allows pan within bounds and clamps pan exceeding bounds', () => {
      // Bounds for 2x on 800x600 are maxX=400, maxY=300
      const inBounds = clampPanOffset({ x: 250, y: -150 }, 2.0, 800, 600);
      assert.deepEqual(inBounds, { x: 250, y: -150 });

      const exceeding = clampPanOffset({ x: 600, y: -450 }, 2.0, 800, 600);
      assert.deepEqual(exceeding, { x: 400, y: -300 });

      const negativeExceeding = clampPanOffset({ x: -900, y: 800 }, 2.0, 800, 600);
      assert.deepEqual(negativeExceeding, { x: -400, y: 300 });
    });
  });

  describe('calculateFocalZoom', () => {
    it('resets to zoom 1.0 and pan (0,0) when nextZoom <= 1.0', () => {
      const res = calculateFocalZoom({
        currentZoom: 2.5,
        nextZoom: 0.9,
        cursorX: 200,
        cursorY: 150,
        containerWidth: 800,
        containerHeight: 600,
        currentPan: { x: 50, y: 50 },
      });
      assert.equal(res.zoom, 1.0);
      assert.deepEqual(res.pan, { x: 0, y: 0 });
    });

    it('keeps center zoom stationary when cursor is at exact center', () => {
      const res = calculateFocalZoom({
        currentZoom: 1.0,
        nextZoom: 2.0,
        cursorX: 400,
        cursorY: 300,
        containerWidth: 800,
        containerHeight: 600,
        currentPan: { x: 0, y: 0 },
      });
      assert.equal(res.zoom, 2.0);
      assert.deepEqual(res.pan, { x: 0, y: 0 });
    });

    it('shifts pan toward cursor position when zooming in off-center', () => {
      // Cursor at top-left corner (0, 0)
      const res = calculateFocalZoom({
        currentZoom: 1.0,
        nextZoom: 2.0,
        cursorX: 0,
        cursorY: 0,
        containerWidth: 800,
        containerHeight: 600,
        currentPan: { x: 0, y: 0 },
      });
      assert.equal(res.zoom, 2.0);
      // Top-left cursor relative to center is (-400, -300)
      // rawPanX = -400 - (-400 - 0) * 2 = +400
      // rawPanY = -300 - (-300 - 0) * 2 = +300
      assert.equal(res.pan.x, 400);
      assert.equal(res.pan.y, 300);
    });
  });

  describe('stepZoom', () => {
    it('increments and decrements zoom by step size', () => {
      assert.equal(stepZoom(1.0, 1), 1.25);
      assert.equal(stepZoom(1.25, 1), 1.5);
      assert.equal(stepZoom(1.5, -1), 1.25);
      // Snapping to 1.0 when close
      assert.equal(stepZoom(1.25, -1), 1.0);
    });

    it('respects MAX_ZOOM boundary', () => {
      assert.equal(stepZoom(4.9, 1), 5.0);
      assert.equal(stepZoom(5.0, 1), 5.0);
    });
  });
});

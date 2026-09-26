import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTooltipPosition } from '../../src/components/common/tooltip_utils.ts';

describe('Tooltip Viewport Boundary & Overflow Prevention', () => {
  const viewport = { width: 1280, height: 720 };

  it('centers tooltip under trigger when ample space is available', () => {
    const triggerRect = {
      top: 100,
      bottom: 140,
      left: 600,
      right: 680,
      width: 80,
      height: 40,
    };
    const tooltipRect = { width: 200, height: 50 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport,
      placement: 'auto',
      padding: 8,
      gap: 6,
    });

    // Ideal center: 600 + (80 - 200)/2 = 600 - 60 = 540
    assert.equal(result.left, 540);
    // Placed below: bottom (140) + gap (6) = 146
    assert.equal(result.top, 146);
    assert.equal(result.actualPlacement, 'bottom');
  });

  it('clamps left coordinate to padding when trigger is at the extreme left edge of the viewport', () => {
    // Button at x=4px, width=40px. Tooltip width=220px.
    // Unclamped center would be: 4 + (40 - 220)/2 = 4 - 90 = -86px (leaking off-screen!)
    const triggerRect = {
      top: 10,
      bottom: 40,
      left: 4,
      right: 44,
      width: 40,
      height: 30,
    };
    const tooltipRect = { width: 220, height: 35 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport,
      placement: 'bottom',
      padding: 10,
      gap: 6,
    });

    // Must be clamped to padding (10px), strictly never negative
    assert.equal(result.left, 10);
    assert.ok(result.left >= 10);
    assert.equal(result.top, 46);
  });

  it('clamps left coordinate to right edge when trigger is at the extreme right edge of the viewport', () => {
    // Viewport width = 1280. Button at x=1240px, width=35px. Tooltip width=200px.
    // Unclamped center would be: 1240 + (35 - 200)/2 = 1240 - 82.5 = 1157.5px.
    // 1157.5 + 200 = 1357.5px > 1280px (leaking off-screen by 77.5px!)
    const triggerRect = {
      top: 20,
      bottom: 50,
      left: 1240,
      right: 1275,
      width: 35,
      height: 30,
    };
    const tooltipRect = { width: 200, height: 35 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport,
      placement: 'auto',
      padding: 8,
      gap: 6,
    });

    // Must be clamped to: viewport.width - tooltipRect.width - padding
    // 1280 - 200 - 8 = 1072px
    assert.equal(result.left, 1072);
    // Tooltip right boundary: 1072 + 200 = 1272 <= 1280 - 8
    assert.ok(result.left + tooltipRect.width <= viewport.width - 8);
  });

  it('flips above trigger when there is insufficient vertical space below', () => {
    // Trigger is near bottom: bottom = 700px. Viewport height = 720px. Space below = 20px.
    // Tooltip height = 120px (e.g. watchers list).
    const triggerRect = {
      top: 670,
      bottom: 700,
      left: 200,
      right: 280,
      width: 80,
      height: 30,
    };
    const tooltipRect = { width: 220, height: 120 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport,
      placement: 'auto',
      padding: 8,
      gap: 6,
    });

    // Space below (20px) < tooltip (120px) + gap (6px) + padding (8px) = 134px.
    // Should flip above: top = triggerRect.top (670) - tooltipRect.height (120) - gap (6) = 544px.
    assert.equal(result.actualPlacement, 'top');
    assert.equal(result.top, 544);
    assert.ok(result.top >= 8);
    assert.ok(result.top + tooltipRect.height <= viewport.height);
  });

  it('handles explicit placement="top" and flips to bottom if insufficient space above', () => {
    // Trigger is at top: top = 10px. Space above = 10px.
    // Tooltip height = 60px.
    const triggerRect = {
      top: 10,
      bottom: 40,
      left: 300,
      right: 360,
      width: 60,
      height: 30,
    };
    const tooltipRect = { width: 150, height: 60 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport,
      placement: 'top',
      padding: 8,
      gap: 6,
    });

    assert.equal(result.actualPlacement, 'bottom');
    assert.equal(result.top, 46); // bottom (40) + gap (6)
  });

  it('clamps top coordinate when vertical space is constrained on both sides', () => {
    const smallViewport = { width: 400, height: 150 };
    const triggerRect = {
      top: 60,
      bottom: 90,
      left: 100,
      right: 180,
      width: 80,
      height: 30,
    };
    // Huge tooltip height 140px in a 150px viewport
    const tooltipRect = { width: 160, height: 140 };

    const result = calculateTooltipPosition({
      triggerRect,
      tooltipRect,
      viewport: smallViewport,
      placement: 'auto',
      padding: 5,
      gap: 4,
    });

    // Must be clamped to: maxTop = 150 - 140 - 5 = 5px
    assert.ok(result.top >= 5);
    assert.ok(result.top + tooltipRect.height <= smallViewport.height);
  });
});

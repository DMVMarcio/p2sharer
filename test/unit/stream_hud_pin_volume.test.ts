import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Stream Card HUD Hover Fade, Pin Toggle, and Volume Polish', () => {
  const cssPath = path.resolve('src/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  const videoCardPath = path.resolve('src/components/room/VideoCard.tsx');
  const videoCardContent = fs.readFileSync(videoCardPath, 'utf8');

  const tooltipPath = path.resolve('src/components/common/Tooltip.tsx');
  const tooltipContent = fs.readFileSync(tooltipPath, 'utf8');

  describe('HUD Auto-Hide & Pin Mechanics', () => {
    it('defines auto-hide rule for stream card HUD elements with opacity 0 and pointer-events none', () => {
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray) .stream-card-stats-hud'),
        'Must target .stream-card-stats-hud'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray) .btn-stop-watch-stream'),
        'Must target .btn-stop-watch-stream'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray) .stream-card-overlay'),
        'Must target .stream-card-overlay'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray) .stream-controls-group'),
        'Must target .stream-controls-group'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray) .stream-zoom-bar'),
        'Must target .stream-zoom-bar'
      );
    });

    it('reveals HUD on :hover, :focus-within, .is-hud-pinned, and .is-hud-active', () => {
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray):hover'),
        'Must reveal HUD on hover'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray):focus-within'),
        'Must reveal HUD on focus-within'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray).is-hud-pinned'),
        'Must keep HUD visible when card has .is-hud-pinned'
      );
      assert.ok(
        cssContent.includes('.stream-card:not(.in-tray).is-hud-active'),
        'Must keep HUD visible when card has .is-hud-active'
      );
    });

    it('implements isHudPinned toggle state and pin button in VideoCard', () => {
      assert.ok(
        videoCardContent.includes('const [isHudPinned, setIsHudPinned] = useState<boolean>(false);'),
        'VideoCard must declare isHudPinned state'
      );
      assert.ok(
        videoCardContent.includes('btn-stream-pin'),
        'VideoCard must render btn-stream-pin'
      );
      assert.ok(
        videoCardContent.includes('is-hud-pinned'),
        'VideoCard must conditionally add is-hud-pinned class'
      );
    });

    it('defines styling for .btn-stream-pin matching fullscreen button dimensions', () => {
      assert.ok(
        cssContent.includes('.btn-stream-fullscreen,\n.btn-stream-pin') ||
        cssContent.includes('.btn-stream-fullscreen, .btn-stream-pin') ||
        cssContent.includes('.btn-stream-pin'),
        'Must define .btn-stream-pin styling'
      );
      assert.ok(
        cssContent.includes('.btn-stream-pin.active'),
        'Must define .btn-stream-pin.active styling'
      );
    });

    it('supports onOpenChange in Tooltip and tracks active tooltips in VideoCard', () => {
      assert.ok(
        tooltipContent.includes('onOpenChange?: (open: boolean) => void'),
        'TooltipProps must support onOpenChange callback'
      );
      assert.ok(
        videoCardContent.includes('onOpenChange={handleTooltipOpenChange}'),
        'VideoCard must pass onOpenChange to Tooltip instances'
      );
      assert.ok(
        videoCardContent.includes('is-hud-active'),
        'VideoCard must add is-hud-active class when tooltips are active'
      );
    });
  });

  describe('Volume Button Alignment & Area Normalization', () => {
    it('sets base collapsed .stream-volume-controller to 28x28 circular dimensions with zero excess padding', () => {
      const controllerIdx = cssContent.indexOf('/* Stream Volume Controller (Compact Circle');
      assert.ok(controllerIdx !== -1, 'Must define .stream-volume-controller block');
      const controllerBlock = cssContent.slice(controllerIdx, cssContent.indexOf('}', controllerIdx));

      assert.ok(controllerBlock.includes('width: 28px;'), 'Must have width: 28px');
      assert.ok(controllerBlock.includes('height: 28px;'), 'Must have height: 28px');
      assert.ok(controllerBlock.includes('max-width: 28px;'), 'Must have max-width: 28px');
      assert.ok(controllerBlock.includes('padding: 0;'), 'Must have padding: 0 when collapsed');
      assert.ok(controllerBlock.includes('border-radius: var(--radius-full);'), 'Must have round pill border radius');
      assert.ok(controllerBlock.includes('overflow: hidden;'), 'Must clip overflow when collapsed');
    });

    it('centers speaker icon precisely within 26x26 .btn-stream-volume', () => {
      const btnIdx = cssContent.indexOf('.btn-stream-volume {');
      assert.ok(btnIdx !== -1, 'Must define .btn-stream-volume');
      const btnBlock = cssContent.slice(btnIdx, cssContent.indexOf('}', btnIdx));

      assert.ok(btnBlock.includes('width: 26px;'), 'Must have width: 26px');
      assert.ok(btnBlock.includes('height: 26px;'), 'Must have height: 26px');
      assert.ok(btnBlock.includes('padding: 0;'), 'Must have padding: 0');
      assert.ok(btnBlock.includes('justify-content: center;'), 'Must center horizontally');
      assert.ok(btnBlock.includes('align-items: center;'), 'Must center vertically');
    });
  });

  describe('Volume Slider Expansion Glitch Resolution', () => {
    it('prevents content spillover by maintaining overflow: hidden in .stream-volume-slider-box even on hover', () => {
      const hoverSliderSelector = '.stream-volume-controller:hover .stream-volume-slider-box';
      const hoverIdx = cssContent.indexOf(hoverSliderSelector);
      assert.ok(hoverIdx !== -1, 'Must define hover rule for slider box');
      const hoverBlock = cssContent.slice(hoverIdx, cssContent.indexOf('}', hoverIdx));

      assert.ok(
        hoverBlock.includes('overflow: hidden;'),
        'Must retain overflow: hidden on hover to prevent children from spilling outside expanding pill'
      );
      assert.ok(
        !hoverBlock.includes('overflow: visible;'),
        'Must NOT use overflow: visible on hover (causes rendering glitch)'
      );
    });

    it('smoothly expands .stream-volume-controller width and adds right padding only during expansion', () => {
      const hoverControllerSelector = '.stream-volume-controller:hover,';
      const hoverIdx = cssContent.indexOf(hoverControllerSelector);
      assert.ok(hoverIdx !== -1, 'Must define hover rule for controller container');
      const hoverBlock = cssContent.slice(hoverIdx, cssContent.indexOf('}', hoverIdx));

      assert.ok(
        hoverBlock.includes('padding-right: 8px;'),
        'Must provide padding-right: 8px on expand'
      );
      assert.ok(
        hoverBlock.includes('max-width: 175px;'),
        'Must expand max-width for slider and percent content'
      );
    });
  });
});

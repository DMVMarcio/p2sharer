import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modalManager } from '../../src/hooks/useModal.ts';

describe('UI Visual Transitions and Animations', () => {
  const cssPath = path.resolve('src/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Helper to extract full keyframes block considering nested braces
  function extractKeyframesBlock(name: string): string {
    const idx = cssContent.indexOf(`@keyframes ${name}`);
    if (idx === -1) return '';
    const openBrace = cssContent.indexOf('{', idx);
    if (openBrace === -1) return '';
    let depth = 1;
    let current = openBrace + 1;
    while (current < cssContent.length && depth > 0) {
      if (cssContent[current] === '{') depth++;
      else if (cssContent[current] === '}') depth--;
      current++;
    }
    return cssContent.slice(openBrace + 1, current - 1);
  }

  describe('Modal Opening and Closing Animation & Scale', () => {
    it('defines modalFadeIn and modalFadeOut keyframes', () => {
      assert.ok(cssContent.includes('@keyframes modalFadeIn'), 'Must define modalFadeIn');
      assert.ok(cssContent.includes('@keyframes modalFadeOut'), 'Must define modalFadeOut');
      const inBody = extractKeyframesBlock('modalFadeIn');
      assert.ok(inBody.includes('opacity: 0') && inBody.includes('opacity: 1'));
      const outBody = extractKeyframesBlock('modalFadeOut');
      assert.ok(outBody.includes('opacity: 1') && outBody.includes('opacity: 0'));
    });

    it('defines modalCardEnter and modalCardExit keyframes for smooth scaling', () => {
      assert.ok(cssContent.includes('@keyframes modalCardEnter'), 'Must define modalCardEnter');
      assert.ok(cssContent.includes('@keyframes modalCardExit'), 'Must define modalCardExit');

      const enterBody = extractKeyframesBlock('modalCardEnter');
      assert.ok(enterBody.includes('transform: scale(0.93)'), 'Must scale up from 0.93 on open');
      assert.ok(enterBody.includes('transform: scale(1)'), 'Must reach scale 1 on open');

      const exitBody = extractKeyframesBlock('modalCardExit');
      assert.ok(exitBody.includes('transform: scale(1)'), 'Must start at scale 1 on close');
      assert.ok(exitBody.includes('transform: scale(0.93)'), 'Must minimize to 0.93 on close');
    });

    it('applies modalCardEnter and modalCardExit to modal cards', () => {
      assert.ok(
        cssContent.includes('.modal-overlay .modal-card'),
        'Must define .modal-overlay .modal-card'
      );
      assert.ok(
        cssContent.includes('.modal-overlay.closing .modal-card'),
        'Must define .modal-overlay.closing .modal-card'
      );
      assert.ok(
        cssContent.includes('.modal-overlay.closing'),
        'Must define .modal-overlay.closing'
      );
    });

    it('manages isClosing state and 240ms exit grace period in modalManager', async () => {
      modalManager.open('settings');
      assert.equal(modalManager.getActive(), 'settings');
      assert.equal(modalManager.getIsClosing(), false);

      modalManager.close();
      assert.equal(modalManager.getActive(), 'settings', 'Active modal remains during exit transition');
      assert.equal(modalManager.getIsClosing(), true, 'isClosing flag becomes true immediately');

      // Wait for exit timer to complete
      await new Promise((r) => setTimeout(r, 260));
      assert.equal(modalManager.getActive(), null, 'Modal unmounts after exit transition completes');
      assert.equal(modalManager.getIsClosing(), false);
    });
  });

  describe('Grid and Spotlight Focus Mode Transitions', () => {
    it('defines viewModeEnter keyframes', () => {
      assert.ok(cssContent.includes('@keyframes viewModeEnter'), 'Must define viewModeEnter keyframes');
      const body = extractKeyframesBlock('viewModeEnter');
      assert.ok(body.length > 0, 'Keyframe block must exist');
      assert.ok(body.includes('opacity: 0'), 'Must animate opacity from 0');
      assert.ok(body.includes('opacity: 1'), 'Must animate opacity to 1');
      assert.ok(body.includes('transform: scale('), 'Must scale for smooth entrance');
    });

    it('applies viewModeEnter to .streams-grid-wrapper:not(.hidden)', () => {
      assert.ok(
        cssContent.includes('.streams-grid-wrapper:not(.hidden)'),
        'Must style active grid wrapper'
      );
      const match = cssContent.match(/\.streams-grid-wrapper:not\(\.hidden\)\s*\{([\s\S]*?)\}/);
      assert.ok(match, 'Rule must match');
      assert.ok(match[1].includes('viewModeEnter'), 'Active grid must trigger viewModeEnter');
    });

    it('applies viewModeEnter to .spotlight-stage:not(.hidden)', () => {
      assert.ok(
        cssContent.includes('.spotlight-stage:not(.hidden)'),
        'Must style active spotlight stage'
      );
      const match = cssContent.match(/\.spotlight-stage:not\(\.hidden\)\s*\{([\s\S]*?)\}/);
      assert.ok(match, 'Rule must match');
      assert.ok(match[1].includes('viewModeEnter'), 'Active spotlight stage must trigger viewModeEnter');
    });
  });

  describe('Spotlight Featured Screen Focus Animation', () => {
    it('defines spotlightFeaturedEnter keyframes', () => {
      assert.ok(
        cssContent.includes('@keyframes spotlightFeaturedEnter'),
        'Must define spotlightFeaturedEnter keyframes'
      );
      const body = extractKeyframesBlock('spotlightFeaturedEnter');
      assert.ok(body.length > 0, 'Keyframe block must exist');
      assert.ok(body.includes('opacity: 0'), 'Must animate opacity from 0');
      assert.ok(body.includes('opacity: 1'), 'Must animate opacity to 1');
    });

    it('applies spotlightFeaturedEnter to spotlight stage stream cards and participant cards', () => {
      const match = cssContent.match(
        /\.spotlight-featured-area \.stream-card,\s*\.spotlight-featured-area \.participant-card\s*\{([\s\S]*?)\}/
      );
      assert.ok(match, 'Spotlight featured cards selector must match');
      assert.ok(
        match[1].includes('spotlightFeaturedEnter'),
        'Featured cards must play spotlightFeaturedEnter animation'
      );
    });
  });

  describe('Dynamic Peer Entry and Layout Animations', () => {
    it('defines peerCardEnter keyframes with subtle, contained scale and translateY pop', () => {
      assert.ok(cssContent.includes('@keyframes peerCardEnter'), 'Must define peerCardEnter keyframes');
      const body = extractKeyframesBlock('peerCardEnter');
      assert.ok(body.length > 0, 'peerCardEnter body must exist');
      assert.ok(body.includes('opacity: 0'), 'Must start at opacity 0');
      assert.ok(body.includes('opacity: 1'), 'Must transition to opacity 1');
      assert.ok(body.includes('transform: scale(0.94)'), 'Must start at subtle 0.94 scale without blowing up');
      assert.ok(!body.includes('scale(1.03)'), 'Must not overshoot above 1.0 to prevent container leaking');
    });

    it('applies peerCardEnter to grid cards and spotlight tray cards with smooth deceleration', () => {
      assert.ok(
        cssContent.includes('.streams-grid-wrapper .stream-card'),
        'Must style grid stream-card'
      );
      assert.ok(
        cssContent.includes('.spotlight-tray-strip .stream-card'),
        'Must style tray stream-card'
      );
      const gridMatch = cssContent.match(
        /\.streams-grid-wrapper \.stream-card,\s*\.streams-grid-wrapper \.participant-card\s*\{([\s\S]*?)\}/
      );
      assert.ok(gridMatch, 'Grid cards selector must match');
      assert.ok(gridMatch[1].includes('peerCardEnter'), 'Grid cards must play peerCardEnter');
      assert.ok(gridMatch[1].includes('cubic-bezier(0.16, 1, 0.3, 1)'), 'Must use smooth deceleration');

      const trayMatch = cssContent.match(
        /\.spotlight-tray-strip \.stream-card,\s*\.spotlight-tray-strip \.participant-card\s*\{([\s\S]*?)\}/
      );
      assert.ok(trayMatch, 'Tray cards selector must match');
      assert.ok(trayMatch[1].includes('peerCardEnter'), 'Tray cards must play peerCardEnter');
    });
  });

  describe('Screen Picker Skeleton Crossfade Layer Architecture', () => {
    it('defines wrapper, skeleton layer, and content layer classes', () => {
      assert.ok(
        cssContent.includes('.picker-sources-container-wrapper'),
        'Must define .picker-sources-container-wrapper'
      );
      assert.ok(
        cssContent.includes('.source-cards-skeleton-layer'),
        'Must define .source-cards-skeleton-layer'
      );
      assert.ok(
        cssContent.includes('.source-cards-skeleton-layer.fade-out'),
        'Must define .source-cards-skeleton-layer.fade-out'
      );
      assert.ok(
        cssContent.includes('.source-cards-content-layer'),
        'Must define .source-cards-content-layer'
      );
    });

    it('fades out skeleton layer smoothly with opacity 0 and pointer-events none over 0.4s', () => {
      const fadeOutMatch = cssContent.match(/\.source-cards-skeleton-layer\.fade-out\s*\{([\s\S]*?)\}/);
      assert.ok(fadeOutMatch, 'Fade out rule must match');
      const body = fadeOutMatch[1];
      assert.ok(body.includes('opacity: 0'), 'Must transition to opacity 0');
      assert.ok(body.includes('pointer-events: none'), 'Must prevent pointer events when fading out');
    });

    it('fades in content layer with sourceCardsFadeIn', () => {
      assert.ok(
        cssContent.includes('@keyframes sourceCardsFadeIn'),
        'Must define sourceCardsFadeIn keyframe'
      );
      const contentMatch = cssContent.match(/\.source-cards-content-layer\s*\{([\s\S]*?)\}/);
      assert.ok(contentMatch, 'Content layer rule must match');
      assert.ok(
        contentMatch[1].includes('sourceCardsFadeIn'),
        'Content layer must play sourceCardsFadeIn'
      );
    });
  });
});

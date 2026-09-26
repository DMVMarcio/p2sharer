import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

  describe('Modal Opening Fade Animation', () => {
    it('defines modalFadeIn keyframes with pure opacity fade', () => {
      assert.ok(cssContent.includes('@keyframes modalFadeIn'), 'Must define modalFadeIn keyframes');
      const body = extractKeyframesBlock('modalFadeIn');
      assert.ok(body.length > 0, 'Keyframe block must exist');
      assert.ok(body.includes('opacity: 0'), 'Must fade from opacity 0');
      assert.ok(body.includes('opacity: 1'), 'Must fade to opacity 1');
      assert.ok(!body.includes('transform'), 'Must not contain transform to maintain pure fade');
    });

    it('applies modalFadeIn animation to .modal-overlay', () => {
      const overlayMatch = cssContent.match(/\.modal-overlay\s*\{([\s\S]*?)\}/);
      assert.ok(overlayMatch, '.modal-overlay must be defined');
      assert.ok(
        overlayMatch[1].includes('modalFadeIn'),
        '.modal-overlay must apply modalFadeIn animation'
      );
    });

    it('applies modalFadeIn animation to .connecting-overlay', () => {
      const connectingMatch = cssContent.match(/\.connecting-overlay\s*\{([\s\S]*?)\}/);
      assert.ok(connectingMatch, '.connecting-overlay must be defined');
      assert.ok(
        connectingMatch[1].includes('modalFadeIn'),
        '.connecting-overlay must apply modalFadeIn animation'
      );
    });
  });

  describe('Grid and Spotlight Focus Mode Transitions', () => {
    it('defines viewModeEnter keyframes', () => {
      assert.ok(cssContent.includes('@keyframes viewModeEnter'), 'Must define viewModeEnter keyframes');
      const body = extractKeyframesBlock('viewModeEnter');
      assert.ok(body.length > 0, 'Keyframe block must exist');
      assert.ok(body.includes('opacity: 0'), 'Must animate opacity from 0');
      assert.ok(body.includes('opacity: 1'), 'Must animate opacity to 1');
      assert.ok(body.includes('transform: scale('), 'Must subtly scale for smooth entrance');
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

    it('fades out skeleton layer smoothly with opacity 0 and pointer-events none', () => {
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

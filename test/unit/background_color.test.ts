import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_PRESETS, backgroundTokens, normalizeBackground } from '../../src/core/background_color.ts';

function luminance(hex: string) {
  const rgb = [1, 3, 5].map(offset => {
    const x = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test('background preferences reject invalid storage and preserve custom colors and OLED', () => {
  assert.equal(normalizeBackground('url(example)'), 'graphite');
  assert.equal(normalizeBackground('#AbC123'), '#AbC123');
  for (const mode of ['dark', 'light'] as const) {
    assert.equal(backgroundTokens('oled', mode).tokens['--bg-app'], '#000000');
    const oled = backgroundTokens('oled', mode).tokens;
    const customBlack = backgroundTokens('#000000', mode).tokens;
    assert.deepEqual(customBlack, oled);
    assert.equal(oled['--hero-background'], oled['--bg-card']);
    assert.notEqual(oled['--hero-background'], oled['--bg-app']);
    assert.notEqual(oled['--bg-control'], oled['--bg-card']);
    assert.notEqual(oled['--bg-control-hover'], oled['--bg-card']);
    assert.equal(backgroundTokens('invalid', mode).tokens['--bg-app'], backgroundTokens('graphite', mode).tokens['--bg-app']);
  }
});

test('preset and custom backgrounds retain readable text on every derived surface', () => {
  const colors = [...BACKGROUND_PRESETS.map(item => item.id), '#ffffff', '#000000', '#777777', '#808080', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff'];
  for (let gray = 0; gray <= 255; gray += 5) colors.push('#' + gray.toString(16).padStart(2, '0').repeat(3));
  for (const color of colors) for (const mode of ['dark', 'light'] as const) {
    const { tokens } = backgroundTokens(color, mode);
    for (const [key, text] of Object.entries(tokens).filter(([key]) => ['--text-primary', '--text-secondary', '--text-muted'].includes(key))) {
      for (const surface of Object.values(tokens).filter((_, index) => Object.keys(tokens)[index].startsWith('--bg-'))) {
        const a = luminance(text), b = luminance(surface);
        const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        assert.ok(contrast >= 4.5, `${color} ${mode} ${key}: ${contrast}`);
      }
    }
  }
});

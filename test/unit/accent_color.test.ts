import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrastingTextColor, customAccentTokens } from '../../src/core/accent_color.ts';
import { automaticCardColor } from '../../src/core/profile_card_color.ts';
import { hexToHsv } from '../../src/core/hsv_color.ts';

test('custom colors validate hex and select contrasting text', () => {
  for (const color of ['cyan', '#fff', '#12345g', 'red; background: white']) {
    assert.equal(customAccentTokens(color), null);
  }
  assert.equal(contrastingTextColor('hsl(60, 65%, 45%)'), '#000000');
  assert.equal(contrastingTextColor('hsl(240, 65%, 45%)'), '#ffffff');
  assert.equal(contrastingTextColor('#ffffff'), '#000000');
  assert.equal(contrastingTextColor('#000000'), '#ffffff');
  assert.equal(customAccentTokens('#ffffff')?.['--custom-accent-text'], '#000000');
  assert.equal(customAccentTokens('#000000')?.['--custom-accent-text'], '#ffffff');
  assert.equal(customAccentTokens('#12AbEf')?.['--custom-accent-color'], '#12AbEf');
  assert.equal(customAccentTokens('#12AbEf')?.['--custom-accent-border'], 'rgba(18, 171, 239, 0.3)');
});

test('automatic card backgrounds preserve hue with subdued saturation and readable white text', () => {
  for (const source of ['#ffffff', '#000000', '#ffff00', '#00ff00', '#00ffff', '#ff0000', '#ff00ff', '#0000ff', '#123456', 'hsl(60, 65%, 45%)']) {
    const color = automaticCardColor(source);
    const hsv = hexToHsv(color);
    assert.equal(contrastingTextColor(color), '#ffffff');
    assert.ok(hsv.s <= 0.43);
    assert.ok(hsv.v <= 0.45);
    if (source.startsWith('#') && hsv.s > 0) {
      const delta = Math.abs(hsv.h - hexToHsv(source).h);
      assert.ok(Math.min(delta, 360 - delta) < 3, 'Dominant hue survives the contrast adjustment');
    }
  }
});

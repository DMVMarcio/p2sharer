import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contrastingTextColor, customAccentTokens } from '../../src/core/accent_color.ts';

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

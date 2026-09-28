import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEditedElapsed } from '../../src/core/chat_time.ts';

test('edited time uses Portuguese relative units and switches to a local date', () => {
  const now = Date.UTC(2026, 8, 28, 12, 0);
  assert.equal(formatEditedElapsed(now - 3_000, now), '3 segundos atrás');
  assert.equal(formatEditedElapsed(now - 3 * 60_000, now), '3 minutos atrás');
  assert.equal(formatEditedElapsed(now - 3 * 3_600_000, now), '3 horas atrás');
  assert.equal(formatEditedElapsed(now - 3 * 86_400_000, now), '3 dias atrás');
  assert.equal(formatEditedElapsed(now - 1_000, now), '1 segundo atrás');
  assert.match(formatEditedElapsed(now - 31 * 86_400_000, now), /\d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfferPool } from '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs';

test('TURN offer pool limits idle allocations while creating extra offers on demand', async () => {
  let created = 0;
  const pool = new OfferPool(() => {
    created++;
    return { isDead: false, destroy() {} };
  });

  try {
    pool.warmup();
    assert.equal(created, 4);
    const offers = await pool.checkout(6, false, async (peer: unknown) => peer);
    assert.equal(offers.length, 6);
    assert.equal(created, 6);
  } finally {
    pool.destroy();
  }
});

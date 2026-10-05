import { test } from 'node:test';
import assert from 'node:assert/strict';
import createPeer from '../../node_modules/@trystero-p2p/core/dist/peer.mjs';
import { OfferPool } from '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs';

const emptySdp = 'v=0\r\ns=fixture\r\nt=0 0\r\n';
const validSdp = `${emptySdp}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;

// Exercise the real peer adapter and offer pool with controlled browser output.
function peerWithSdp(initialSdp, restartedSdp = initialSdp) {
  class Connection extends EventTarget {
    connectionState = 'new'; signalingState = 'stable'; iceGatheringState = 'complete';
    localDescription = null; remoteDescription = null;
    createDataChannel() {
      return { readyState: 'connecting', close() { this.readyState = 'closed'; } };
    }
    async createOffer(options) { return { type: 'offer', sdp: options?.iceRestart ? restartedSdp : initialSdp }; }
    async setLocalDescription(description) {
      if (description?.type === 'rollback') {
        this.localDescription = null;
        this.signalingState = 'stable';
      } else {
        this.localDescription = description ?? { type: 'offer', sdp: initialSdp };
        this.signalingState = 'have-local-offer';
      }
    }
    restartIce() {}
    close() { this.connectionState = 'closed'; }
  }
  return createPeer(true, { rtcPolyfill: Connection, trickleIce: true });
}

test('initial data-channel offers reject empty SDP and rejected application sections', async () => {
  for (const sdp of [emptySdp, `${emptySdp}m=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\n`]) {
    const peer = peerWithSdp(sdp);
    try { await assert.rejects(peer.getOffer(), /no active data channel/); }
    finally { peer.destroy(); }
  }
});

test('offer checkout immediately destroys an empty offer and replaces it with a fresh peer', async () => {
  const peers = [];
  const pool = new OfferPool(() => {
    const peer = peerWithSdp(peers.length === 0 ? emptySdp : validSdp);
    peers.push(peer);
    return peer;
  });
  try {
    pool.warmup();
    const [record] = await pool.checkout(1, false, (peer) => peer.getOffer());
    assert.equal(peers.length, 5);
    assert.equal(peers[0].isDead, true);
    assert.equal(record.peer, peers[4]);
    assert.equal(record.offer.sdp, validSdp);
    record.peer.destroy();
  } finally { pool.destroy(); }
});

test('recycled rollback offers without a data section never reenter the pool', async () => {
  const pool = new OfferPool(() => peerWithSdp(validSdp));
  const peer = peerWithSdp(validSdp, emptySdp);
  try {
    pool.warmup();
    await peer.getOffer();
    pool.recycle(peer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peer.isDead, true);
    assert.ok(!pool.pooled.has(peer));
    const [record] = await pool.checkout(1, false, (candidate) => candidate.getOffer());
    assert.equal(record.offer.sdp, validSdp);
    record.peer.destroy();
  } finally { peer.destroy(); pool.destroy(); }
});

test('repeated invalid fresh offers fail after one bounded retry instead of publishing empty SDP', async () => {
  let created = 0;
  const pool = new OfferPool(() => { created++; return peerWithSdp(emptySdp); });
  try {
    await assert.rejects(pool.checkout(1, false, (peer) => peer.getOffer()), /no active data channel/);
    assert.equal(created, 2);
  } finally { pool.destroy(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createPeer from '../../node_modules/@trystero-p2p/core/dist/peer.mjs';
import { OfferPool } from '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs';
import { createSignalHandler } from '../../node_modules/@trystero-p2p/core/dist/signal-handler.mjs';
import { SharedPeerManager } from '../../node_modules/@trystero-p2p/core/dist/shared-peer.mjs';

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

function createRenegotiationConnection(initialState = 'stable') {
  let offerCounter = 0;
  class RenegotiationConnection extends EventTarget {
    connectionState = 'connected';
    signalingState = initialState;
    iceGatheringState = 'complete';
    localDescription = null;
    remoteDescription = { type: 'offer', sdp: `${validSdp}a=ice-ufrag:remote0\r\n` };
    channel = { readyState: 'open', bufferedAmountLowThreshold: 0, close() { this.readyState = 'closed'; }, send() {} };
    rollbackCount = 0;
    setRemoteCount = 0;
    createDataChannel() { return this.channel; }
    async createOffer() { return { type: 'offer', sdp: `${validSdp}a=ice-ufrag:local${++offerCounter}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` }; }
    async createAnswer() { return { type: 'answer', sdp: `${validSdp}a=ice-ufrag:ans${offerCounter}\r\n` }; }
    async setLocalDescription(description) {
      if (description?.type === 'rollback') {
        this.rollbackCount++;
        this.localDescription = null;
        this.signalingState = 'stable';
        return;
      }
      if (!description) {
        if (this.signalingState === 'have-remote-offer') {
          this.localDescription = await this.createAnswer();
          this.signalingState = 'stable';
        } else {
          this.localDescription = await this.createOffer();
          this.signalingState = 'have-local-offer';
        }
        return;
      }
      this.localDescription = description;
      this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    }
    async setRemoteDescription(desc) {
      this.setRemoteCount++;
      this.remoteDescription = desc;
      this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async addIceCandidate() {}
    getSenders() { return []; }
    close() { this.connectionState = 'closed'; }
  }
  return new RenegotiationConnection();
}

test('renegotiation offers without a=rtpmap on open DataChannel are answered instead of dropped', async () => {
  const conn = createRenegotiationConnection('stable');
  const peer = createPeer(false, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const signals = [];
  let errors = 0;
  peer.setHandlers({ signal: (s) => signals.push(s), error: () => errors++ });
  conn.ondatachannel({ channel: conn.channel });
  try {
    const mediaRemovalOffer = { type: 'offer', sdp: `${validSdp}m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\n` };
    await peer.signal(mediaRemovalOffer);
    assert.equal(errors, 0);
    assert.equal(signals.at(-1)?.type, 'answer');
    assert.equal(conn.signalingState, 'stable');
  } finally { peer.destroy(); }
});

test('stale answers arriving in stable state never raise a fatal peer error', async () => {
  const conn = createRenegotiationConnection('stable');
  const peer = createPeer(true, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  let errors = 0;
  peer.setHandlers({ signal: () => {}, error: () => errors++ });
  try {
    await peer.signal({ type: 'answer', sdp: `${validSdp}a=ice-ufrag:stale\r\n` });
    assert.equal(errors, 0);
    assert.equal(conn.isDead, undefined);
    assert.equal(peer.isDead, false);
  } finally { peer.destroy(); }
});

test('polite peer rolls back glare offer, answers remote offer, and queues follow-up renegotiation', async () => {
  const conn = createRenegotiationConnection('stable');
  const peer = createPeer(false, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const signals = [];
  let errors = 0;
  peer.setHandlers({ signal: (s) => signals.push(s), error: () => errors++ });
  conn.ondatachannel({ channel: conn.channel });
  try {
    await peer.renegotiate();
    assert.equal(conn.signalingState, 'have-local-offer');
    await peer.signal({ type: 'offer', sdp: `${validSdp}a=ice-ufrag:remote1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` });
    assert.equal(conn.rollbackCount, 1);
    assert.equal(errors, 0);
    assert.equal(signals.some((s) => s.type === 'answer'), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signals.filter((s) => s.type === 'offer').length >= 2, true, 'queued renegotiation emits fresh offer after glare');
  } finally { peer.destroy(); }
});

test('renegotiate recovers a stale unanswered have-local-offer after timeout', async (context) => {
  context.mock.timers.enable({ apis: ['Date'] });
  const conn = createRenegotiationConnection('stable');
  const peer = createPeer(true, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const signals = [];
  peer.setHandlers({ signal: (s) => signals.push(s) });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conn.signalingState, 'have-local-offer');
    context.mock.timers.tick(9000);
    await peer.renegotiate();
    assert.equal(conn.rollbackCount, 1);
    assert.equal(signals.filter((s) => s.type === 'offer').length >= 2, true);
  } finally { peer.destroy(); }
});

test('fatal SDP collision errors tear down an open peer instead of looping', async () => {
  const conn = createRenegotiationConnection('stable');
  const origSetRemote = conn.setRemoteDescription.bind(conn);
  let shouldFailFatal = false;
  conn.setRemoteDescription = async (desc) => {
    if (shouldFailFatal) {
      const err = new Error('Failed to set remote offer sdp: Session error code: ERROR_CONTENT. RTP extension ID reassignment not supported');
      err.name = 'InvalidAccessError';
      throw err;
    }
    return origSetRemote(desc);
  };
  const peer = createPeer(false, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const errors = [];
  peer.setHandlers({ signal: () => {}, error: (err) => errors.push(err) });
  conn.ondatachannel({ channel: conn.channel });
  try {
    shouldFailFatal = true;
    await peer.signal({ type: 'offer', sdp: `${validSdp}a=ice-ufrag:fatal1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /RTP extension ID reassignment|failed to apply remote signal/i);
  } finally { peer.destroy(); }
});

test('transient open-peer negotiation errors recover up to threshold then fail', async () => {
  const conn = createRenegotiationConnection('stable');
  const origSetLocal = conn.setLocalDescription.bind(conn);
  let failCreateOffer = false;
  conn.setLocalDescription = async (desc) => {
    if (!desc && failCreateOffer && conn.signalingState === 'stable') {
      throw new Error('transient negotiation failure');
    }
    return origSetLocal(desc);
  };
  const peer = createPeer(false, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const errors = [];
  peer.setHandlers({ signal: () => {}, error: (err) => errors.push(err) });
  conn.ondatachannel({ channel: conn.channel });
  try {
    failCreateOffer = true;
    await peer.renegotiate();
    await peer.renegotiate();
    await peer.renegotiate();
    assert.equal(errors.length, 0, 'recovers for up to 3 consecutive transient errors');
    // Successful remote offer+answer resets counter
    await peer.signal({ type: 'offer', sdp: `${validSdp}a=ice-ufrag:ok1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` });
    assert.equal(errors.length, 0);
    // Now 3 transient errors recover, 4th escalates
    await peer.renegotiate();
    await peer.renegotiate();
    await peer.renegotiate();
    assert.equal(errors.length, 0);
    await peer.renegotiate();
    assert.equal(errors.length, 1);
  } finally { peer.destroy(); }
});

test('stale answer m-line mismatch on open peer is ignored instead of tearing down connection', async () => {
  const conn = createRenegotiationConnection('stable');
  const origSetRemote = conn.setRemoteDescription.bind(conn);
  let failStaleAnswer = false;
  conn.setRemoteDescription = async (desc) => {
    if (desc?.type === 'answer' && failStaleAnswer) {
      const err = new Error("Failed to set remote answer sdp: The order of m-lines in answer doesn't match order in offer. Rejecting answer.");
      err.name = 'InvalidAccessError';
      throw err;
    }
    return origSetRemote(desc);
  };
  const peer = createPeer(true, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const errors = [];
  peer.setHandlers({ signal: () => {}, error: (err) => errors.push(err) });
  try {
    await peer.renegotiate();
    assert.equal(conn.signalingState, 'have-local-offer');
    failStaleAnswer = true;
    await peer.signal({ type: 'answer', sdp: `${validSdp}a=ice-ufrag:stale1\r\n` });
    assert.equal(errors.length, 0);
    assert.equal(peer.isDead, false);
    assert.equal(conn.signalingState, 'have-local-offer');
  } finally { peer.destroy(); }
});

test('duplicate initial negotiationneeded before remote answer never emits a second empty offer', async () => {
  const conn = createRenegotiationConnection('stable');
  conn.remoteDescription = null;
  conn.connectionState = 'new';
  conn.channel.readyState = 'connecting';
  conn.createOffer = async () => ({ type: 'offer', sdp: `${validSdp}a=ice-ufrag:init0\r\n` });
  const peer = createPeer(true, { rtcPolyfill: class { constructor() { return conn; } }, trickleIce: true });
  const signals = [];
  peer.setHandlers({ signal: (s) => signals.push(s) });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conn.signalingState, 'have-local-offer');
    // Simulate Chromium firing its queued negotiationneeded for createDataChannel("data")
    // while the initial offer is still awaiting the remote answer.
    await conn.onnegotiationneeded?.(new Event('negotiationneeded'));
    const offersBeforeAnswer = signals.filter((s) => s.type === 'offer').length;
    await peer.signal({ type: 'answer', sdp: `${validSdp}a=ice-ufrag:ans0\r\n` });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(conn.signalingState, 'stable', 'initiator must stay stable after initial answer');
    assert.equal(signals.filter((s) => s.type === 'offer').length, offersBeforeAnswer);
  } finally { peer.destroy(); }
});

test('signal handler replaces a stalled answering peer when a newer offerId arrives after abort/rejoin', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const createdPeers = [];
  const sent = [];
  const ctx = {
    appId: 'app',
    roomId: 'room',
    config: {},
    peerStates: {},
    rootTopicPlaintext: 'root',
    rootTopicP: Promise.resolve('root-topic'),
    selfTopicP: Promise.resolve('self-topic'),
    toPlain: async (s) => s,
    toCipher: async (s) => s,
    isLeaving: () => false,
    isPassive: false,
    isActive: true,
    sharedPeers: new SharedPeerManager(),
    offerPool: { recycle() {} },
    initPeer: () => {
      let signalHandler = null;
      const peer = {
        isDead: false,
        destroyed: false,
        connection: { connectionState: 'connecting', iceConnectionState: 'checking' },
        setHandlers(h) { if (h.signal) signalHandler = h.signal; },
        async signal() { signalHandler?.({ type: 'answer', sdp: `${validSdp}a=ice-ufrag:ans\r\n` }); },
        destroy() { this.isDead = true; this.destroyed = true; },
      };
      createdPeers.push(peer);
      return peer;
    },
    connectPeer() {},
    disconnectPeer() {},
    attachSharedPeerToRoom() {},
    checkDeactivate() {},
    announceIntervals: [],
    announceIntervalMs: 5000,
  };
  const handler = createSignalHandler(ctx)(0);
  const remotePeerId = 'remote-offerer-peer';
  const sendSignal = (topic, msg) => sent.push({ topic, msg });

  await handler('self-topic', JSON.stringify({ peerId: remotePeerId, offerId: 'offer-probe-1', offer: validSdp }), sendSignal);
  assert.equal(createdPeers.length, 1);

  // Duplicate delivery of the same offerId is ignored even after time passes.
  context.mock.timers.tick(1500);
  await handler('self-topic', JSON.stringify({ peerId: remotePeerId, offerId: 'offer-probe-1', offer: validSdp }), sendSignal);
  assert.equal(createdPeers.length, 1);
  assert.equal(createdPeers[0].destroyed, false);

  // A fresh offerId from the same peer replaces the stalled answering peer.
  await handler('self-topic', JSON.stringify({ peerId: remotePeerId, offerId: 'offer-room-2', offer: validSdp }), sendSignal);
  assert.equal(createdPeers.length, 2);
  assert.equal(createdPeers[0].destroyed, true);
  assert.equal(ctx.peerStates[remotePeerId].answeringOfferId, 'offer-room-2');
  clearTimeout(ctx.peerStates[remotePeerId].answeringExpiryTimer);
});

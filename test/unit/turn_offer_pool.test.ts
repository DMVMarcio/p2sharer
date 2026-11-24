import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfferPool } from '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs';
import createStrategy from '../../node_modules/@trystero-p2p/core/dist/strategy.mjs';

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

test('strategy scopes OfferPool per room so background probes without TURN cannot freeze subsequent rooms', async () => {
  const capturedGetOffers: Array<(n: number) => Promise<unknown[]>> = [];
  const createdConfigs: Array<{ room: string; rtcConfig: RTCConfiguration | undefined }> = [];

  const createRecordingPolyfill = (roomTag: string) => class extends EventTarget {
    connectionState = 'new';
    signalingState = 'stable';
    iceGatheringState = 'complete';
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    constructor(configuration?: RTCConfiguration) {
      super();
      createdConfigs.push({ room: roomTag, rtcConfig: configuration });
    }
    createDataChannel() {
      return { readyState: 'connecting', close() { this.readyState = 'closed'; } };
    }
    async createOffer() {
      return {
        type: 'offer' as const,
        sdp: 'v=0\r\ns=fixture\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      };
    }
    async setLocalDescription(description?: RTCSessionDescriptionInit) {
      if (description?.type === 'rollback') {
        this.localDescription = null;
        this.signalingState = 'stable';
      } else {
        this.localDescription = description ?? await this.createOffer();
        this.signalingState = 'have-local-offer';
      }
    }
    close() { this.connectionState = 'closed'; }
  };

  const joinRoom = createStrategy({
    init: () => ({}),
    subscribe: (_relay: unknown, _root: unknown, _self: unknown, _onMsg: unknown, getOffers: (n: number) => Promise<unknown[]>) => {
      capturedGetOffers.push(getOffers);
      return () => {};
    },
    announce: () => {},
  });

  const probeTurn = undefined;
  const probeRtc: RTCConfiguration = { iceServers: [] };
  const roomTurn: RTCConfiguration = {
    iceServers: [{ urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'p' }],
  };

  const probeRoom = joinRoom(
    { appId: 'turn-scope-test', rtcConfig: probeRtc, turnConfig: probeTurn, rtcPolyfill: createRecordingPolyfill('probe'), trickleIce: true },
    'probe-room',
    { backgroundProbe: true },
  );

  // Background probe must not warm idle offer peers before any remote peer is seen.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(createdConfigs.length, 0);

  const mainRoom = joinRoom(
    { appId: 'turn-scope-test', rtcConfig: roomTurn, rtcPolyfill: createRecordingPolyfill('main'), trickleIce: true },
    'main-room',
    { backgroundProbe: false },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(capturedGetOffers.length, 2);

    const mainOffers = await capturedGetOffers[1]!(1);
    assert.equal(mainOffers.length, 1);

    const mainConfigs = createdConfigs.filter((entry) => entry.room === 'main');
    assert.ok(mainConfigs.length >= 1);
    assert.ok(mainConfigs.every((entry) =>
      entry.rtcConfig?.iceServers?.some((server) =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => url === 'turn:relay.example.com:3478'))));

    // Leaving the probe room while mainRoom stays active must not tear down mainRoom's pool or peers.
    await probeRoom.leave();
    const extraMainOffers = await capturedGetOffers[1]!(1);
    assert.equal(extraMainOffers.length, 1);
  } finally {
    await probeRoom.leave().catch(() => {});
    await mainRoom.leave().catch(() => {});
  }
});

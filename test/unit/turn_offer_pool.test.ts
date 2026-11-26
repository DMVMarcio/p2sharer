import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfferPool } from '../../node_modules/@trystero-p2p/core/dist/offer-pool.mjs';
import createStrategy from '../../node_modules/@trystero-p2p/core/dist/strategy.mjs';
import { clearConnectedPeer, createSignalHandler } from '../../node_modules/@trystero-p2p/core/dist/signal-handler.mjs';
import { sha1 } from '../../node_modules/@trystero-p2p/core/dist/crypto.mjs';

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

test('direct ICE progress extends timeout before TURN fallback and disconnect resets fallback flag', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const rootTopicPlaintext = 'trystero/progress-app/room-1';
  const rootTopic = await sha1(rootTopicPlaintext);
  const selfTopic = await sha1(`${rootTopicPlaintext}/local-self`);

  const makeMockPeer = (hasProgress: boolean) => {
    let handlers: Record<string, (...args: unknown[]) => void> = {};
    const peer = {
      isDead: false,
      connection: {
        iceConnectionState: 'checking',
        connectionState: 'connecting',
        remoteDescription: null as unknown,
        async getStats() {
          return new Map([
            ['pair-1', {
              type: 'candidate-pair',
              nominated: hasProgress,
              responsesReceived: hasProgress ? 3 : 0,
              requestsReceived: hasProgress ? 4 : 0,
            }],
          ]);
        },
      },
      setHandlers(next: Record<string, (...args: unknown[]) => void>) {
        handlers = { ...handlers, ...next };
      },
      async signal(desc: { type?: string }) {
        this.connection.remoteDescription = desc;
        if (desc?.type === 'offer') {
          handlers.signal?.({ type: 'answer', sdp: 'plain-answer-sdp' });
        }
      },
      destroy() {
        this.isDead = true;
      },
    };
    return peer;
  };

  let nextPeerHasProgress = true;
  const ctx: any = {
    appId: 'progress-app',
    roomId: 'room-1',
    config: {
      appId: 'progress-app',
      rtcConfig: { iceServers: [] },
      fallbackRtcConfig: { iceServers: [{ urls: 'turn:relay.example.com:3478' }] },
    },
    peerStates: {},
    rootTopicPlaintext,
    rootTopicP: Promise.resolve(rootTopic),
    selfTopicP: Promise.resolve(selfTopic),
    toPlain: async (s: any) => s,
    toCipher: async (s: any) => s,
    isLeaving: () => false,
    isPassive: false,
    isActive: true,
    sharedPeers: { get: () => undefined, getHealth: () => 'live', clear: () => {} },
    offerPool: { recycle: () => {}, claimLeased: () => {} },
    initPeer: () => makeMockPeer(nextPeerHasProgress),
    connectPeer: () => {},
    disconnectPeer: () => {},
    attachSharedPeerToRoom: () => {},
    checkDeactivate: () => {},
    announceIntervals: [5333],
    announceIntervalMs: 5333,
  };

  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  const handler = createSignalHandler(ctx)(0);
  await handler(selfTopic, { peerId: 'zzzzzzzzzzzzzzzzzzzz', offer: 'cipher-offer', offerId: 'offer1234567' }, () => {});
  await flushMicrotasks();

  const stateWithProgress = ctx.peerStates['zzzzzzzzzzzzzzzzzzzz'];
  assert.ok(stateWithProgress?.answeringPeer, 'answering peer should be active');
  assert.equal(stateWithProgress.useFallbackRtc, false);

  // At 6000ms, active ICE progress (e.g. Teredo checks succeeding) must extend rather than fall back to TURN.
  context.mock.timers.tick(6100);
  await flushMicrotasks();
  assert.equal(stateWithProgress.useFallbackRtc, false, 'active direct ICE progress must prevent premature 6s TURN fallback');
  assert.equal(stateWithProgress.directFallbackExtended, true);

  // Once the extra 5000ms grace expires without completing, it escalates to TURN fallback.
  context.mock.timers.tick(5100);
  await flushMicrotasks();
  assert.equal(stateWithProgress.useFallbackRtc, true, 'stalled progress eventually falls back after grace window');

  // If that peer connects and later disconnects, useFallbackRtc resets so future reconnects retry direct P2P first.
  const liveConnPeer = makeMockPeer(true);
  stateWithProgress.connectedPeer = liveConnPeer;
  clearConnectedPeer(stateWithProgress, 'zzzzzzzzzzzzzzzzzzzz', 'disconnect');
  assert.equal(stateWithProgress.useFallbackRtc, false, 'disconnecting a live peer resets TURN fallback lock');

  // Conversely, a peer with zero ICE responses escalates immediately at 6000ms without extension.
  nextPeerHasProgress = false;
  await handler(selfTopic, { peerId: 'yyyyyyyyyyyyyyyyyyyy', offer: 'cipher-offer-2', offerId: 'offer7654321' }, () => {});
  await flushMicrotasks();
  const stateNoProgress = ctx.peerStates['yyyyyyyyyyyyyyyyyyyy'];
  context.mock.timers.tick(6100);
  await flushMicrotasks();
  assert.equal(stateNoProgress.useFallbackRtc, true, 'zero direct ICE packets escalates at initial 6s deadline');
});

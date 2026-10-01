import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';

describe('Video encoder selection', () => {
  const codecs = [
    { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=64001f' },
    { mimeType: 'video/AV1' },
    { mimeType: 'video/VP8' },
    { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' },
  ];
  const software = { supported: true, smooth: true, powerEfficient: false };

  it('uses the faster VP8 fallback when WebRTC reports software encoding', () => {
    const support = new Map([
      ['video/h264;profile-level-id=64001f', software],
      ['video/av1', software], ['video/vp8', software],
    ]);
    const sorted = MediaCoordinator.sortCodecs(codecs, support);
    assert.equal(sorted[0].mimeType, 'video/VP8');
    assert.equal(sorted.at(-1)?.mimeType, 'video/rtx');
    assert.equal(sorted.length, codecs.length);
  });

  it('preserves hardware encoding ahead of the software fallback', () => {
    const support = new Map([
      ['video/h264;profile-level-id=64001f', software],
      ['video/av1', { ...software, powerEfficient: true }], ['video/vp8', software],
    ]);
    assert.deepEqual(MediaCoordinator.sortCodecs(codecs, support).map((codec) => codec.mimeType),
      ['video/AV1', 'video/VP8', 'video/H264', 'video/rtx']);
  });

  it('keeps the established codec order when encoding capabilities are unavailable', () => {
    assert.equal(MediaCoordinator.sortCodecs(codecs)[0].mimeType, 'video/H264');
  });

  it('does not override the broadcaster codec order on receiving-only transceivers', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'RTCRtpSender');
    Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true,
      value: { getCapabilities: () => ({ codecs }) } });
    let configured = 0;
    try {
      const receiving = { sender: { track: null }, receiver: { track: { kind: 'video' } },
        setCodecPreferences: () => { throw new Error('Receiving codec preference changed'); } };
      const sending = { sender: { track: { kind: 'video' } },
        setCodecPreferences: () => { configured++; } };
      MediaCoordinator.configureCodecPreferences({ getTransceivers: () => [receiving, sending] } as unknown as RTCPeerConnection);
      assert.equal(configured, 1);
    } finally {
      if (original) Object.defineProperty(globalThis, 'RTCRtpSender', original);
      else Reflect.deleteProperty(globalThis, 'RTCRtpSender');
    }
  });
});

describe('MediaCoordinator SDP Munging and WebRTC Bandwidth Allocation', () => {
  const sampleSdp = [
    'v=0',
    'o=- 123456789 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 9',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    'a=rtpmap:97 VP8/90000',
  ].join('\r\n');

  it('injects bandwidth lines after c= and before a= in the video section', () => {
    const munged = MediaCoordinator.mungeSdpBitrates(sampleSdp, 8000, 25000);
    assert.match(munged, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96 97\r\nc=IN IP4 0\.0\.0\.0\r\nb=AS:25000\r\nb=TIAS:25000000\r\na=rtpmap:96/);
  });

  it('keeps repeated global munging valid and skips RTX parameters', () => {
    const withRtx = `${sampleSdp}\r\na=rtpmap:98 rtx/90000\r\na=fmtp:98 apt=96\r\n`;
    const once = MediaCoordinator.mungeSdpBitrates(withRtx);
    assert.equal(MediaCoordinator.mungeSdpBitrates(once), once);
    assert.match(once, /a=fmtp:98 apt=96\r\n/);
    assert.doesNotMatch(once, /a=fmtp:98 apt=96;x-google/);
    assert.ok(once.endsWith('\r\n'));
    assert.match(once, /a=fmtp:97 .*\r\n$/);
  });

  it('appends x-google-min-bitrate, start-bitrate and max-bitrate to existing a=fmtp lines', () => {
    const munged = MediaCoordinator.mungeSdpBitrates(sampleSdp, 8000, 25000);
    assert.match(
      munged,
      /a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-min-bitrate=8000;x-google-start-bitrate=12000;x-google-max-bitrate=25000/
    );
  });

  it('creates synthetic a=fmtp lines for video payload types missing fmtp lines', () => {
    const munged = MediaCoordinator.mungeSdpBitrates(sampleSdp, 8000, 25000);
    assert.match(
      munged,
      /a=fmtp:97 x-google-min-bitrate=8000;x-google-start-bitrate=12000;x-google-max-bitrate=25000/
    );
  });

  it('does not mutate audio or non-video lines and isolates fmtp strictly within m=video section', () => {
    const multiSectionSdp = [
      'v=0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=mid:0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
      'c=IN IP4 0.0.0.0',
      'a=mid:1',
      'a=rtpmap:96 H264/90000',
      'a=rtpmap:97 VP8/90000',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      'a=mid:2',
      'a=rtpmap:111 opus/48000/2',
    ].join('\r\n');

    const munged = MediaCoordinator.mungeSdpBitrates(multiSectionSdp, 8000, 25000);
    const audioIdx = munged.indexOf('m=audio');
    const vp8FmtpIdx = munged.indexOf('a=fmtp:97');

    assert.ok(audioIdx !== -1);
    assert.ok(vp8FmtpIdx !== -1);
    // a=fmtp:97 must occur BEFORE m=audio starts
    assert.ok(vp8FmtpIdx < audioIdx, 'Video fmtp line must precede m=audio section');
    assert.doesNotMatch(munged.slice(audioIdx), /a=fmtp:97/, 'm=audio must not contain video fmtp');
  });

  it('handles empty or non-string input safely without throwing', () => {
    assert.strictEqual(MediaCoordinator.mungeSdpBitrates(''), '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(MediaCoordinator.mungeSdpBitrates(null as any), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(MediaCoordinator.mungeSdpBitrates(undefined as any), undefined);
  });

  it('intercepts parameterless setLocalDescription cleanly with global WebRTC munging', async () => {
    let setLocalCalledWith: any = null;

    class MockRTCPeerConnection {
      signalingState: string = 'stable';
      async createOffer() {
        return { type: 'offer', sdp: sampleSdp };
      }
      async createAnswer() {
        return { type: 'answer', sdp: sampleSdp };
      }
      async setLocalDescription(desc?: any) {
        setLocalCalledWith = desc;
      }
      async setRemoteDescription() {}
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
    MediaCoordinator.initGlobalWebRtcMunging();

    const pc = new MockRTCPeerConnection();
    // Simulate parameterless call from @trystero-p2p/core
    await pc.setLocalDescription();

    assert.ok(setLocalCalledWith, 'setLocalDescription must receive the generated munged offer');
    assert.match(setLocalCalledWith.sdp, /b=AS:25000/);
    assert.match(setLocalCalledWith.sdp, /x-google-min-bitrate=500/);
  });

  it('lets video yield bandwidth to high-priority audio', async () => {
    const videoParams: any = { encodings: [{ minBitrate: 12_500_000 }] };
    const audioParams: any = { encodings: [{}] };
    const pc = {
      signalingState: 'stable',
      getSenders: () => [
        { track: { kind: 'video' }, getParameters: () => videoParams, setParameters: async () => {} },
        { track: { kind: 'audio' }, getParameters: () => audioParams, setParameters: async () => {} },
      ],
    } as unknown as RTCPeerConnection;
    await MediaCoordinator.applySenderBitrate(pc, 25_000_000, 60);
    assert.equal(videoParams.encodings[0].minBitrate, undefined);
    assert.equal(videoParams.encodings[0].networkPriority, 'medium');
    assert.equal(audioParams.encodings[0].networkPriority, 'high');
    assert.equal(audioParams.encodings[0].maxBitrate, 192000);
  });

  it('executes requestKeyFrame without throwing on supported or unsupported senders', async () => {
    let keyFrameTriggered = false;
    const mockPc = {
      getSenders: () => [
        {
          track: { kind: 'video' },
          generateKeyFrame: async () => {
            keyFrameTriggered = true;
          },
        },
        {
          track: { kind: 'audio' },
        },
      ],
    } as unknown as RTCPeerConnection;

    await MediaCoordinator.requestKeyFrame(mockPc);
    assert.strictEqual(keyFrameTriggered, true);

    // Fault tolerant check
    await MediaCoordinator.requestKeyFrame(null as unknown as RTCPeerConnection);
    await MediaCoordinator.requestKeyFrame({} as unknown as RTCPeerConnection);
  });
});

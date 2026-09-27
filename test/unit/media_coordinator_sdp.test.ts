import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCoordinator } from '../../src/p2p/media_coordinator.ts';

describe('MediaCoordinator SDP Munging and WebRTC Bitrate Floor Architecture', () => {
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

  it('injects b=AS and b=TIAS right under m=video', () => {
    const munged = MediaCoordinator.mungeSdpBitrates(sampleSdp, 8000, 25000);
    assert.match(munged, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96 97\r\nb=AS:25000\r\nb=TIAS:25000000/);
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
    assert.match(setLocalCalledWith.sdp, /x-google-min-bitrate=8000/);
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

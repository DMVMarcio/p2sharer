import type { StreamStatusPayload } from '../core/types.ts';

export class MediaCoordinator {
  /**
   * Sorts WebRTC video codecs according to hardware acceleration priority:
   * 1. video/H264 (NVENC, QuickSync, VCN hardware encoding)
   * 2. video/AV1
   * 3. video/VP9
   * 4. video/VP8 (fallback)
   * 5. others
   */
  public static sortCodecs<T extends { mimeType: string; sdpFmtpLine?: string }>(codecs: T[]): T[] {
    const h264High = codecs.filter(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        Boolean(c.sdpFmtpLine?.toLowerCase().includes('profile-level-id=6400'))
    );
    const h264Other = codecs.filter(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        !c.sdpFmtpLine?.toLowerCase().includes('profile-level-id=6400')
    );
    const av1Codecs = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/av1');
    const vp9Codecs = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp9');
    const vp8Codecs = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8');
    const otherCodecs = codecs.filter((c) => {
      const mime = c.mimeType.toLowerCase();
      return (
        mime !== 'video/h264' &&
        mime !== 'video/av1' &&
        mime !== 'video/vp9' &&
        mime !== 'video/vp8'
      );
    });

    return [...h264High, ...h264Other, ...av1Codecs, ...vp9Codecs, ...vp8Codecs, ...otherCodecs];
  }

  private static globalMungingInitialized = false;

  /**
   * Installs global monkey-patches on RTCPeerConnection.prototype to ensure
   * all SDP offers and answers (including parameterless setLocalDescription() used by Trystero)
   * are munged with robust bitrate floor/ceiling (b=AS, b=TIAS, x-google-min-bitrate).
   */
  public static initGlobalWebRtcMunging(): void {
    if (MediaCoordinator.globalMungingInitialized) return;
    if (typeof RTCPeerConnection === 'undefined' || !RTCPeerConnection.prototype) return;
    MediaCoordinator.globalMungingInitialized = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = RTCPeerConnection.prototype as any;
    const origCreateOffer = proto.createOffer;
    const origCreateAnswer = proto.createAnswer;
    const origSetLocalDescription = proto.setLocalDescription;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto.createOffer = async function (options?: any) {
      const offer = await origCreateOffer.call(this, options);
      if (offer && offer.sdp) {
        offer.sdp = MediaCoordinator.mungeSdpBitrates(offer.sdp);
      }
      return offer;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto.createAnswer = async function (options?: any) {
      const answer = await origCreateAnswer.call(this, options);
      if (answer && answer.sdp) {
        answer.sdp = MediaCoordinator.mungeSdpBitrates(answer.sdp);
      }
      return answer;
    };

    proto.setLocalDescription = async function (
      description?: RTCLocalSessionDescriptionInit
    ) {
      if (!description) {
        // Parameterless setLocalDescription() as invoked by modern WebRTC / Trystero:
        // Automatically generate offer or answer, munge SDP with high-bitrate floor/ceiling, and apply it.
        try {
          if (this.signalingState === 'have-remote-offer' || this.signalingState === 'have-local-pranswer') {
            const answer = await origCreateAnswer.call(this);
            if (answer && answer.sdp) {
              answer.sdp = MediaCoordinator.mungeSdpBitrates(answer.sdp);
            }
            return await origSetLocalDescription.call(this, answer);
          } else {
            const offer = await origCreateOffer.call(this);
            if (offer && offer.sdp) {
              offer.sdp = MediaCoordinator.mungeSdpBitrates(offer.sdp);
            }
            return await origSetLocalDescription.call(this, offer);
          }
        } catch {
          return origSetLocalDescription.call(this);
        }
      } else {
        if (description && description.sdp) {
          description.sdp = MediaCoordinator.mungeSdpBitrates(description.sdp);
        }
        return origSetLocalDescription.call(this, description);
      }
    };
  }

  /**
   * Munges SDP to enforce Google WebRTC bitrate floor and ceiling (x-google-min-bitrate, x-google-max-bitrate, b=AS, b=TIAS).
   * Confines video bitrate and fmtp parameters strictly inside the m=video section so they never bleed into m=audio or m=application.
   */
  public static mungeSdpBitrates(
    sdp: string,
    minBitrateKbps: number = 500,
    maxBitrateKbps: number = 25000
  ): string {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const lines = sdp.split(/\r?\n/);
    const result: string[] = [];
    const bitrateParameters = `x-google-min-bitrate=${minBitrateKbps};x-google-start-bitrate=${Math.round(minBitrateKbps * 1.5)};x-google-max-bitrate=${maxBitrateKbps}`;

    for (let start = 0; start < lines.length;) {
      let end = start + 1;
      while (end < lines.length && !lines[end].startsWith('m=')) end++;
      const section = lines.slice(start, end);
      if (!section[0].startsWith('m=video ')) {
        result.push(...section);
        start = end;
        continue;
      }

      let trailingEmptyLines = 0;
      while (section.length > 1 && section[section.length - 1] === '') {
        section.pop();
        trailingEmptyLines++;
      }

      const payloads = section[0].split(/\s+/).slice(3);
      const videoCodecs = new Set<string>();
      const existingFmtp = new Set<string>();
      for (const line of section) {
        const codec = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1|AV01)\//i.exec(line);
        if (codec) videoCodecs.add(codec[1]);
        const fmtp = /^a=fmtp:(\d+)\s/.exec(line);
        if (fmtp) existingFmtp.add(fmtp[1]);
      }

      // RFC 4566 media sections order i=/c=/b=/a=. Inserting b= immediately
      // after m= (before c=) makes Chromium reject the entire offer.
      const firstAttribute = section.findIndex((line) => line.startsWith('a='));
      const bandwidthAt = firstAttribute >= 0 ? firstAttribute : section.length;
      const hasAs = section.some((line) => line.startsWith('b=AS:'));
      const hasTias = section.some((line) => line.startsWith('b=TIAS:'));
      for (let index = 0; index < section.length; index++) {
        if (index === bandwidthAt) {
          if (!hasAs) result.push(`b=AS:${maxBitrateKbps}`);
          if (!hasTias) result.push(`b=TIAS:${maxBitrateKbps * 1000}`);
        }
        const line = section[index];
        const fmtp = /^a=fmtp:(\d+)\s/.exec(line);
        if (fmtp && videoCodecs.has(fmtp[1]) && !line.includes('x-google-min-bitrate')) {
          result.push(`${line};${bitrateParameters}`);
        } else {
          result.push(line);
        }
      }
      if (bandwidthAt === section.length) {
        if (!hasAs) result.push(`b=AS:${maxBitrateKbps}`);
        if (!hasTias) result.push(`b=TIAS:${maxBitrateKbps * 1000}`);
      }
      for (const payload of payloads) {
        if (videoCodecs.has(payload) && !existingFmtp.has(payload)) {
          result.push(`a=fmtp:${payload} ${bitrateParameters}`);
        }
      }
      for (let index = 0; index < trailingEmptyLines; index++) result.push('');
      start = end;
    }
    return result.join('\r\n');
  }

  /**
   * Transparently intercepts RTCPeerConnection.setLocalDescription to inject
   * SDP bitrate parameters for hardware and software rate controllers.
   */
  public static patchPeerConnectionSdp(pc: RTCPeerConnection): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!pc || (pc as any).__sdp_munged) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pc as any).__sdp_munged = true;

    const originalSetLocalDescription = pc.setLocalDescription.bind(pc);
    const originalCreateOffer = pc.createOffer ? pc.createOffer.bind(pc) : null;
    const originalCreateAnswer = pc.createAnswer ? pc.createAnswer.bind(pc) : null;

    pc.setLocalDescription = async function (description?: RTCLocalSessionDescriptionInit) {
      if (!description) {
        try {
          if (
            (pc.signalingState === 'have-remote-offer' || pc.signalingState === 'have-local-pranswer') &&
            originalCreateAnswer
          ) {
            const answer = await originalCreateAnswer();
            if (answer && answer.sdp) {
              answer.sdp = MediaCoordinator.mungeSdpBitrates(answer.sdp);
            }
            return await originalSetLocalDescription(answer);
          } else if (originalCreateOffer) {
            const offer = await originalCreateOffer();
            if (offer && offer.sdp) {
              offer.sdp = MediaCoordinator.mungeSdpBitrates(offer.sdp);
            }
            return await originalSetLocalDescription(offer);
          }
        } catch {
          return originalSetLocalDescription();
        }
      } else {
        if (description && description.sdp) {
          description.sdp = MediaCoordinator.mungeSdpBitrates(description.sdp);
        }
        return originalSetLocalDescription(description);
      }
    };
  }

  /**
   * Prioritizes hardware accelerated codecs (H.264, AV1, VP9, VP8) on all video transceivers
   */
  public static configureCodecPreferences(pc: RTCPeerConnection): void {
    if (!pc || typeof pc.getTransceivers !== 'function') return;

    if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
      try {
        const capabilities = RTCRtpSender.getCapabilities('video');
        if (capabilities && capabilities.codecs && capabilities.codecs.length > 0) {
          const prioritized = MediaCoordinator.sortCodecs(capabilities.codecs);

          pc.getTransceivers().forEach((transceiver) => {
            const isVideo =
              transceiver.sender?.track?.kind === 'video' ||
              transceiver.receiver?.track?.kind === 'video' ||
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (transceiver as any).kind === 'video' ||
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (transceiver as any).mid === 'video';

            if (isVideo && typeof transceiver.setCodecPreferences === 'function') {
              try {
                transceiver.setCodecPreferences(prioritized);
              } catch (err) {
                console.warn('[MediaCoordinator] Failed to set codec preferences:', err);
              }
            }
          });
        }
      } catch (err) {
        console.warn('[MediaCoordinator] Error querying video capabilities:', err);
      }
    }
  }

  /**
   * Configures maximum bitrate and degradation preference for video senders
   */
  public static async applySenderBitrate(
    pc: RTCPeerConnection,
    maxBitrateBps: number,
    maxFps: number = 60
  ): Promise<void> {
    if (!pc || typeof pc.getSenders !== 'function') return;
    if (pc.signalingState && pc.signalingState !== 'stable') return;
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings.forEach((enc) => {
              enc.maxBitrate = maxBitrateBps;
              // A high video floor prevents congestion control from yielding
              // bandwidth to the audio track on constrained uplinks.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              delete (enc as any).minBitrate;
              enc.maxFramerate = maxFps;
              enc.scaleResolutionDownBy = 1.0;
              enc.networkPriority = 'medium';
              enc.priority = 'medium';
            });
            // Enforce 'maintain-resolution' so WebRTC never downscales the stream resolution
            // (e.g. from 1080p down to 720p/540p/360p/270p/180p) during network fluctuations.
            // For screen sharing, preserving text legibility and full resolution is paramount;
            // if bandwidth drops, WebRTC will drop framerate slightly instead of blurring the screen.
            try {
              (params as any).degradationPreference = 'maintain-resolution';
            } catch {
              try {
                (params as any).degradationPreference = 'balanced';
              } catch {}
            }
            await sender.setParameters(params);

            // Enforce 'detail' contentHint to enable Screen Content Coding, prevent deblocking blur,
            // and eliminate mosquito ringing around high-contrast text and UI elements.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (sender.track && 'contentHint' in sender.track) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (sender.track as any).contentHint = 'detail';
            }

            // Immediately trigger an intra-keyframe to prevent encoder QP lock at low start bitrate
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (typeof (sender as any).generateKeyFrame === 'function') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (sender as any).generateKeyFrame().catch(() => {});
            }
          } catch (err) {
            console.warn('Failed to apply sender bitrate parameters:', err);
          }
        } else if (sender.track && sender.track.kind === 'audio') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings.forEach((enc) => {
              enc.maxBitrate = 192000; // 192 kbps high-fidelity stereo audio
              enc.networkPriority = 'high';
              enc.priority = 'high';
            });
            await sender.setParameters(params);
          } catch {}
        }
      }
    } catch (err) {
      console.warn('Failed to apply sender bitrate parameters:', err);
    }
  }

  /**
   * Forces video senders to encode an immediate IDR intra-keyframe with low QP,
   * refreshing video sharpness and preventing encoder QP lock on static desktop content.
   */
  public static async requestKeyFrame(pc: RTCPeerConnection): Promise<void> {
    if (!pc || typeof pc.getSenders !== 'function') return;
    if (pc.signalingState && pc.signalingState !== 'stable') return;
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (typeof (sender as any).generateKeyFrame === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (sender as any).generateKeyFrame().catch(() => {});
          }
        }
      }
    } catch {}
  }

  /**
   * Targeted media stream dispatch strictly passing `{ target: peerId }`.
   * Prevents accidental broadcast leakage to other room participants and transceiver bloat.
   */
  public static targetedAddStream(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room: any,
    stream: MediaStream,
    targetPeerId: string
  ): Promise<void>[] {
    if (!room || !stream || !targetPeerId) return [];
    try {
      // Must strictly pass `{ target: targetPeerId }` object option
      return room.addStream(stream, { target: targetPeerId });
    } catch (err) {
      console.warn(`[MediaCoordinator] Error in targetedAddStream for peer ${targetPeerId}:`, err);
      return [];
    }
  }

  /**
   * Broadcasts stream to all target peers using targeted dispatch, or room broadcast if no peers specified.
   */
  public static broadcastStream(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room: any,
    stream: MediaStream,
    targetPeerIds?: string[]
  ): Promise<void>[] {
    if (!room || !stream) return [];
    if (targetPeerIds && targetPeerIds.length > 0) {
      const promises: Promise<void>[] = [];
      targetPeerIds.forEach((pId) => {
        promises.push(...MediaCoordinator.targetedAddStream(room, stream, pId));
      });
      return promises;
    }
    try {
      return room.addStream(stream);
    } catch (err) {
      console.warn('[MediaCoordinator] Error adding broadcast stream:', err);
      return [];
    }
  }

  /**
   * Tunes receiver jitter buffer and playout delay hint on incoming video receivers,
   * while preserving audio receivers untouched to protect NetEQ packet loss concealment.
   */
  public static tuneReceiverJitterBuffer(pc: RTCPeerConnection): void {
    if (!pc || typeof pc.getReceivers !== 'function') return;
    try {
      pc.getReceivers().forEach((receiver) => {
        const isVideo = receiver.track && receiver.track.kind === 'video';
        if (isVideo) {
          // Set playoutDelayHint to 0.02s (20ms) to provide a 1-frame jitter smoothing cushion,
          // preventing dropped frames and mouse judder while keeping real-time latency imperceptible.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (typeof (receiver as any).playoutDelayHint !== 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (receiver as any).playoutDelayHint = 0.02;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (typeof (receiver as any).jitterBufferTarget !== 'undefined') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (receiver as any).jitterBufferTarget = 20;
          }
        }
      });
    } catch {}
  }

  /**
   * Builds the stream_status recovery payload emitted when screen sharing toggles on/off.
   */
  public static buildStreamStatusPayload(
    stream: MediaStream | null,
    isStreaming: boolean,
    senderName?: string
  ): StreamStatusPayload {
    if (!stream || !isStreaming) {
      return {
        isStreaming: false,
        senderName,
        timestamp: Date.now(),
      };
    }

    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    const settings = videoTrack?.getSettings?.();

    return {
      isStreaming: true,
      senderName,
      streamId: stream.id,
      videoTrackId: videoTrack?.id,
      audioTrackId: audioTrack?.id,
      hasAudio: Boolean(audioTrack),
      width: settings?.width,
      height: settings?.height,
      fps: settings?.frameRate ? Math.round(settings.frameRate) : undefined,
      timestamp: Date.now(),
    };
  }

  /**
   * Determines whether a viewer needs to trigger the stream recovery protocol (stream_req)
   * upon receiving a stream_status announcement.
   *
   * Triggers recovery if:
   * 1. Broadcaster reports active streaming (isStreaming === true), AND
   * 2. Viewer has no active MediaStream, or the current stream is inactive,
   *    or the video track has ended, or the broadcaster's streamId has changed (e.g. after toggle).
   */
  public static shouldRequestStreamRecovery(
    currentStream: MediaStream | null | undefined,
    incomingStatus: StreamStatusPayload,
    lastKnownBroadcasterStreamId?: string
  ): boolean {
    if (!incomingStatus.isStreaming) {
      return false;
    }

    if (!currentStream) {
      return true;
    }

    const videoTracks = currentStream.getVideoTracks();
    if (videoTracks.length === 0) {
      return true;
    }

    const hasLiveVideoTrack = videoTracks.some((t) => t.readyState === 'live');
    if (!hasLiveVideoTrack) {
      return true;
    }

    // If lastKnownBroadcasterStreamId is provided and video track is live,
    // only trigger recovery if broadcaster actually switched to a different stream ID
    if (lastKnownBroadcasterStreamId !== undefined && incomingStatus.streamId) {
      return lastKnownBroadcasterStreamId !== '' && lastKnownBroadcasterStreamId !== incomingStatus.streamId;
    }

    if (incomingStatus.streamId && currentStream.id !== incomingStatus.streamId) {
      return true;
    }

    return false;
  }
}

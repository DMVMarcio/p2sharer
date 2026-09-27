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
    const origSetRemoteDescription = proto.setRemoteDescription;

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

    proto.setRemoteDescription = async function (
      description: RTCSessionDescriptionInit
    ) {
      if (description && description.sdp) {
        description.sdp = MediaCoordinator.mungeSdpBitrates(description.sdp);
      }
      return origSetRemoteDescription.call(this, description);
    };
  }

  /**
   * Munges SDP to enforce Google WebRTC bitrate floor and ceiling (x-google-min-bitrate, x-google-max-bitrate, b=AS, b=TIAS)
   */
  public static mungeSdpBitrates(
    sdp: string,
    minBitrateKbps: number = 8000,
    maxBitrateKbps: number = 25000
  ): string {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const lines = sdp.split(/\r?\n/);
    let inVideo = false;
    const modifiedLines: string[] = [];
    const videoPayloadTypes: string[] = [];
    const fmtpPayloadTypes: Set<string> = new Set();

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      if (line.startsWith('m=video')) {
        inVideo = true;
        const parts = line.split(' ');
        for (let p = 3; p < parts.length; p++) {
          if (parts[p]) videoPayloadTypes.push(parts[p]);
        }
        modifiedLines.push(line);

        // Ensure b=AS and b=TIAS lines exist right after m=video line if not already present
        const nextLine1 = lines[i + 1] || '';
        const nextLine2 = lines[i + 2] || '';
        if (!nextLine1.startsWith('b=AS:') && !nextLine2.startsWith('b=AS:')) {
          modifiedLines.push(`b=AS:${maxBitrateKbps}`);
        }
        if (!nextLine1.startsWith('b=TIAS:') && !nextLine2.startsWith('b=TIAS:')) {
          modifiedLines.push(`b=TIAS:${maxBitrateKbps * 1000}`);
        }
        continue;
      }

      if (line.startsWith('m=audio') || line.startsWith('m=application')) {
        inVideo = false;
      }

      if (inVideo && line.startsWith('a=fmtp:')) {
        const colonIdx = line.indexOf(':');
        const spaceIdx = line.indexOf(' ', colonIdx);
        if (colonIdx !== -1 && spaceIdx !== -1) {
          const pt = line.slice(colonIdx + 1, spaceIdx).trim();
          fmtpPayloadTypes.add(pt);
        }

        // Append x-google-min-bitrate, start-bitrate and max-bitrate if not already present
        if (!line.includes('x-google-min-bitrate')) {
          line = `${line};x-google-min-bitrate=${minBitrateKbps};x-google-start-bitrate=${Math.round(minBitrateKbps * 1.5)};x-google-max-bitrate=${maxBitrateKbps}`;
        }
      }

      modifiedLines.push(line);
    }

    if (inVideo || videoPayloadTypes.length > 0) {
      for (const pt of videoPayloadTypes) {
        if (!fmtpPayloadTypes.has(pt)) {
          modifiedLines.push(
            `a=fmtp:${pt} x-google-min-bitrate=${minBitrateKbps};x-google-start-bitrate=${Math.round(minBitrateKbps * 1.5)};x-google-max-bitrate=${maxBitrateKbps}`
          );
          fmtpPayloadTypes.add(pt);
        }
      }
    }

    return modifiedLines.join('\r\n');
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
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
          try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            const minBitrate = Math.round(maxBitrateBps * 0.5);
            params.encodings.forEach((enc) => {
              enc.maxBitrate = maxBitrateBps;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (enc as any).minBitrate = minBitrate;
              enc.maxFramerate = maxFps;
              enc.scaleResolutionDownBy = 1.0;
              enc.networkPriority = 'high';
              enc.priority = 'high';
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (receiver as any).playoutDelayHint = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (receiver as any).jitterBufferTarget = 0;
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

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
  public static sortCodecs<T extends { mimeType: string }>(codecs: T[]): T[] {
    const h264Codecs = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
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

    return [...h264Codecs, ...av1Codecs, ...vp9Codecs, ...vp8Codecs, ...otherCodecs];
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
            params.encodings[0].maxBitrate = maxBitrateBps;
            params.encodings[0].maxFramerate = maxFps;
            params.encodings[0].scaleResolutionDownBy = 1.0;
            params.encodings[0].networkPriority = 'high';
            params.encodings[0].priority = 'high';
            // Maintain full resolution (prevent blurry downscaling to intermediate resolutions)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (params as any).degradationPreference = 'maintain-resolution';
            await sender.setParameters(params);

            // Enforce 'detail' contentHint to prevent WebRTC from lowering spatial resolution or blurring on camera motion
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (sender.track && 'contentHint' in sender.track) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (sender.track as any).contentHint = 'detail';
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
    incomingStatus: StreamStatusPayload
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

    if (incomingStatus.streamId && currentStream.id !== incomingStatus.streamId) {
      return true;
    }

    return false;
  }
}

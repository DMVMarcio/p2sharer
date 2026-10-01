import { streamOwner } from "../core/media_streams.ts";
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { stateStore } from '../core/state_store.ts';
import type { StreamWatcher } from '../core/types.ts';
import { roomService } from './room_service.ts';
import { buildIceServers } from '../p2p/ice_config.ts';
import { audioContextManager } from '../audio/audio_context_manager.ts';
import { validPipAudioSettings } from './pip_audio.ts';

interface PipSession {
  pc: RTCPeerConnection;
  bc: BroadcastChannel | null;
  unlistenSignal: UnlistenFn | null;
  stream: MediaStream | null;
  pendingCandidates: RTCIceCandidateInit[];
  statsInterval: ReturnType<typeof setInterval> | null;
  requestOffer: (() => Promise<void>) | null;
}

export class PipService {
  private static instance: PipService | null = null;
  private sessions: Map<string, PipSession> = new Map();
  private unlistenCloseEvent: UnlistenFn | null = null;

  public static getInstance(): PipService {
    if (!PipService.instance) {
      PipService.instance = new PipService();
    }
    return PipService.instance;
  }

  constructor() {
    this.initTauriListener();
  }

  private async initTauriListener(): Promise<void> {
    try {
      this.unlistenCloseEvent = await listen<string>('pip-window-closed', (event) => {
        const peerId = event.payload;
        if (peerId) {
          this.handlePipWindowClosed([...this.sessions.keys()].find((key) => key.replace(/[^a-zA-Z0-9_-]/g, "_") === peerId) || peerId);
        }
      });
    } catch {
      // In web-only test environments, Tauri listen may not be available
    }
  }

  public async openPip(
    peerId: string,
    senderName: string,
    stream: MediaStream | null
  ): Promise<void> {
    if (this.sessions.has(peerId)) {
      // Focus existing window
      try {
        await invoke('open_pip_window', {
          peerId,
          title: senderName || 'Transmissão',
        });
      } catch (err) {
        console.warn('[PipService] Error focusing PiP window:', err);
      }
      return;
    }

    stateStore.setPeerPipActive(peerId, true);

    // Resolve active media stream with fallback
    let activeStream = stream;
    if (!activeStream) {
      const slot = stateStore.roomSlots.find((s) => s.peerId === peerId);
      activeStream = slot?.stream || null;
    }
    if (!activeStream && streamOwner(peerId) === 'local') {
      activeStream =
        (roomService.roomManager as unknown as { localStream?: MediaStream | null })?.localStream ||
        (roomService as unknown as { nativeVideoBridge?: { activeStream?: MediaStream | null } })?.nativeVideoBridge?.activeStream ||
        null;
    }
    if (streamOwner(peerId) !== 'local' && activeStream?.getAudioTracks().length) {
      audioContextManager.attachPeerAudio(peerId, activeStream);
    }

    const channelName = `p2sharer-pip-${peerId}`;
    const bc: BroadcastChannel | null =
      !isTauri() && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(channelName)
        : null;

    const iceServers = typeof RTCPeerConnection !== 'undefined' ? buildIceServers() : [];
    const pc =
      typeof RTCPeerConnection !== 'undefined'
        ? new RTCPeerConnection({ iceServers })
        : ({
            addTrack: () => {},
            removeTrack: () => {},
            getSenders: () => [],
            createOffer: async () => ({ sdp: '', type: 'offer' as RTCSdpType }),
            createAnswer: async () => ({ sdp: '', type: 'answer' as RTCSdpType }),
            setLocalDescription: async () => {},
            setRemoteDescription: async () => {},
            addIceCandidate: async () => {},
            close: () => {},
            onicecandidate: null,
          } as unknown as RTCPeerConnection);

    const session: PipSession = {
      pc,
      bc,
      unlistenSignal: null,
      stream: activeStream,
      pendingCandidates: [],
      statsInterval: null,
      requestOffer: null,
    };
    this.sessions.set(peerId, session);

    // The main WebView retains the audio sink; the PiP WebView only renders video.
    if (activeStream) {
      activeStream.getVideoTracks().forEach((track) => {
        try {
          pc.addTrack(track, activeStream!);
        } catch (err) {
          console.warn('[PipService] Error adding track to loopback:', err);
        }
      });
    }

    const sendSignal = (data: Record<string, unknown>) => {
      const payload = { ...data, sender: 'main' };
      if (isTauri()) {
        emit(`pip-signal-${peerId}`, payload).catch((err) => {
          console.warn('[PipService] Failed to send PiP signal:', err);
        });
      } else {
        try { bc?.postMessage(payload); } catch {}
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({
          type: 'candidate',
          candidate: e.candidate.toJSON(),
        });
      }
    };

    let offerPending = false;
    let creatingOffer = false;
    let lastOfferFailureAt = 0;
    const sendOffer = async () => {
      if (creatingOffer || pc.signalingState !== 'stable') return;
      if (Date.now() - lastOfferFailureAt < 2000) return;
      if (!session.stream?.getVideoTracks().some((track) => track.readyState !== 'ended')) return;
      creatingOffer = true;
      offerPending = false;
      try {
        // Re-attach tracks if needed
        const senders = pc.getSenders();
        if (senders.length === 0 && session.stream) {
          session.stream.getVideoTracks().forEach((t) => {
            try {
              pc.addTrack(t, session.stream!);
            } catch {}
          });
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const audioState = audioContextManager.getPeerVolumeState(peerId);
        sendSignal({
          type: 'offer',
          sdp: pc.localDescription?.sdp || offer.sdp,
          senderName,
          isLocal: streamOwner(peerId) === 'local',
          pointerEligible: stateStore.roomSlots.find((slot) => slot.peerId === peerId)?.pointerEligible !== false,
          audioSettings: streamOwner(peerId) === 'local' ? { volume: 0, muted: true }
            : { volume: audioState.volume, muted: audioState.isMuted },
        });
      } catch (err) {
        console.warn('[PipService] Error creating loopback offer:', err);
        lastOfferFailureAt = Date.now();
        offerPending = false;
        sendSignal({ type: 'error', message: 'Falha ao negociar a transmissão.' });
      } finally {
        creatingOffer = false;
      }
    };
    session.requestOffer = async () => {
      offerPending = true;
      await sendOffer();
    };

    const handleSignalData = async (data: Record<string, unknown>) => {
      if (!data || typeof data !== 'object') return;
      if (data.sender === 'main') return;

      switch (data.type) {
        case 'pip-ready':
        case 'pip-request-stream': {
          if (data.type === 'pip-request-stream' &&
              (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
            pc.restartIce?.();
          }
          await sendOffer();
          break;
        }
        case 'answer': {
          if (data.sdp && typeof data.sdp === 'string') {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
              // Drain any queued candidates
              while (session.pendingCandidates.length > 0) {
                const cand = session.pendingCandidates.shift();
                if (cand) {
                  await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
                }
              }
              if (offerPending) void sendOffer();
            } catch (err) {
              console.warn('[PipService] Error setting loopback remote answer:', err);
            }
          }
          break;
        }
        case 'candidate': {
          if (data.candidate && typeof data.candidate === 'object') {
            const cand = data.candidate as RTCIceCandidateInit;
            try {
              if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } else {
                session.pendingCandidates.push(cand);
              }
            } catch (err) {
              console.warn('[PipService] Error adding loopback ICE candidate:', err);
            }
          }
          break;
        }
        case 'pip-close': {
          await this.restoreFromPip(peerId);
          break;
        }
        case 'audio-settings': {
          if (streamOwner(peerId) !== 'local' && validPipAudioSettings(data)) {
            audioContextManager.setPeerVolume(peerId, data.volume, data.muted);
          }
          break;
        }
      }
    };

    // Use one signaling transport at a time; duplicate offers can race WebRTC state.
    if (bc) {
      bc.onmessage = async (event) => {
        await handleSignalData(event.data);
      };
    }

    if (isTauri()) {
      try {
        session.unlistenSignal = await listen<Record<string, unknown>>(`pip-signal-${peerId}`, async (event) => {
          await handleSignalData(event.payload);
        });
      } catch {
        // Tauri listener is unavailable in web-only environments.
      }
    }

    // Periodic stats dispatcher
    session.statsInterval = setInterval(async () => {
      try {
        const ping = roomService.getPeerPing(peerId);
        const stats = await roomService.roomManager?.getPeerStats(peerId);
        const slot = stateStore.roomSlots.find((sl) => sl.peerId === peerId);
        const signalingStatus = roomService.roomManager?.getSignalingStatus?.();

        sendSignal({
          type: 'stats',
          stats: {
            pingMs: ping ?? null,
            fps: stats?.fps ?? (streamOwner(peerId) === 'local' ? stateStore.currentFps : 60),
            bitrateKbps: stats?.bitrateKbps ?? 0,
            height: stats?.height ? `${stats.height}p` : '1080p',
            watchers: (slot?.watchers ?? []) as StreamWatcher[],
            configuredBitrateKbps: stateStore.currentBitrate,
            transportTag: signalingStatus?.activeTransport
              ? ` [${signalingStatus.activeTransport.toUpperCase()}]`
              : '',
          },
        });
      } catch {
        // Safe to ignore transient stats query failures
      }
    }, 1200);

    if (session.statsInterval && typeof (session.statsInterval as unknown as { unref?: () => void }).unref === 'function') {
      (session.statsInterval as unknown as { unref: () => void }).unref();
    }

    // Invoke Tauri command to open frameless window
    try {
      await invoke('open_pip_window', {
        peerId,
        title: senderName || 'Transmissão',
      });
    } catch (err) {
      console.warn('[PipService] Failed to invoke open_pip_window:', err);
      if (isTauri()) this.handlePipWindowClosed([...this.sessions.keys()].find((key) => key.replace(/[^a-zA-Z0-9_-]/g, "_") === peerId) || peerId);
    }
  }

  public updateStream(peerId: string, stream: MediaStream | null): void {
    const session = this.sessions.get(peerId);
    if (!session) return;

    const newVideoTrack = stream?.getVideoTracks()[0];
    const videoSender = session.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (session.stream === stream && videoSender?.track === newVideoTrack) return;
    session.stream = stream;
    try {
      if (streamOwner(peerId) !== 'local' && stream?.getAudioTracks().length) {
        audioContextManager.attachPeerAudio(peerId, stream);
      }
      if (videoSender && newVideoTrack) {
        void videoSender.replaceTrack(newVideoTrack).catch((error) => console.warn('[PiP] Live video replacement failed:', error));
        return;
      }
      const currentSenders = session.pc.getSenders();
      currentSenders.forEach((sender) => {
        try {
          session.pc.removeTrack(sender);
        } catch {}
      });

      if (stream) {
        stream.getVideoTracks().forEach((track) => {
          try {
            session.pc.addTrack(track, stream);
          } catch {}
        });
      }

      void session.requestOffer?.();
    } catch (err) {
      console.warn('[PipService] Error updating loopback stream:', err);
    }
  }

  public async restoreFromPip(peerId: string): Promise<void> {
    const session = this.sessions.get(peerId);
    if (session) {
      if (session.statsInterval) {
        clearInterval(session.statsInterval);
      }
      if (session.unlistenSignal) {
        session.unlistenSignal();
        session.unlistenSignal = null;
      }
      try {
        session.bc?.postMessage({ type: 'main-closed' });
        session.bc?.close();
      } catch {}
      try {
        emit(`pip-signal-${peerId}`, { type: 'main-closed' }).catch(() => {});
      } catch {}
      try {
        session.pc.close();
      } catch {}
      this.sessions.delete(peerId);
    }

    try {
      await invoke('close_pip_window', { peerId });
    } catch {}

    stateStore.setPeerPipActive(peerId, false);
  }

  private handlePipWindowClosed(peerId: string): void {
    const session = this.sessions.get(peerId);
    if (session) {
      if (session.statsInterval) {
        clearInterval(session.statsInterval);
      }
      if (session.unlistenSignal) {
        session.unlistenSignal();
        session.unlistenSignal = null;
      }
      try {
        session.bc?.close();
      } catch {}
      try {
        session.pc.close();
      } catch {}
      this.sessions.delete(peerId);
    }
    stateStore.setPeerPipActive(peerId, false);
  }

  public async closeAllPipWindows(): Promise<void> {
    const peerIds = Array.from(this.sessions.keys());
    for (const peerId of peerIds) {
      await this.restoreFromPip(peerId);
    }
  }

  public destroy(): void {
    this.closeAllPipWindows();
    if (this.unlistenCloseEvent) {
      this.unlistenCloseEvent();
      this.unlistenCloseEvent = null;
    }
  }
}

export const pipService = PipService.getInstance();

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { stateStore } from '../core/state_store.ts';
import { roomService } from './room_service.ts';

interface PipSession {
  pc: RTCPeerConnection;
  bc: BroadcastChannel;
  stream: MediaStream | null;
  statsInterval: ReturnType<typeof setInterval> | null;
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
          this.handlePipWindowClosed(peerId);
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

    const channelName = `p2sharer-pip-${peerId}`;
    const bc = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(channelName)
      : ({ postMessage: () => {}, close: () => {}, onmessage: null } as unknown as BroadcastChannel);

    const pc = typeof RTCPeerConnection !== 'undefined'
      ? new RTCPeerConnection({ iceServers: [] })
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
      stream,
      statsInterval: null,
    };
    this.sessions.set(peerId, session);

    // Attach existing stream tracks to loopback peer connection
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          pc.addTrack(track, stream);
        } catch (err) {
          console.warn('[PipService] Error adding track to loopback:', err);
        }
      });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        bc.postMessage({
          type: 'candidate',
          candidate: e.candidate.toJSON(),
        });
      }
    };

    const sendOffer = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        bc.postMessage({
          type: 'offer',
          sdp: offer.sdp,
          senderName,
          isLocal: peerId === 'local',
        });
      } catch (err) {
        console.warn('[PipService] Error creating loopback offer:', err);
      }
    };

    bc.onmessage = async (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'pip-ready': {
          await sendOffer();
          break;
        }
        case 'answer': {
          if (data.sdp) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
            } catch (err) {
              console.warn('[PipService] Error setting loopback remote answer:', err);
            }
          }
          break;
        }
        case 'candidate': {
          if (data.candidate) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              console.warn('[PipService] Error adding loopback ICE candidate:', err);
            }
          }
          break;
        }
        case 'pip-request-stream': {
          await sendOffer();
          break;
        }
        case 'pip-close': {
          await this.restoreFromPip(peerId);
          break;
        }
      }
    };

    // Periodic stats dispatcher
    session.statsInterval = setInterval(async () => {
      try {
        const ping = roomService.getPeerPing(peerId);
        const stats = await roomService.roomManager?.getPeerStats(peerId);
        const slot = stateStore.roomSlots.find((sl) => sl.peerId === peerId);
        const watchersCount = slot?.watchers?.length ?? 0;

        bc.postMessage({
          type: 'stats',
          stats: {
            pingMs: ping ?? null,
            fps: stats?.fps ?? (peerId === 'local' ? stateStore.currentFps : 60),
            bitrateKbps: stats?.bitrateKbps ?? 0,
            height: stats?.height ? `${stats.height}p` : '1080p',
            watchersCount,
          },
        });
      } catch {
        // Safe to ignore transient stats query failures
      }
    }, 1200);

    if (session.statsInterval && typeof (session.statsInterval as any).unref === 'function') {
      (session.statsInterval as any).unref();
    }

    // Invoke Tauri command to open frameless window
    try {
      await invoke('open_pip_window', {
        peerId,
        title: senderName || 'Transmissão',
      });
    } catch (err) {
      console.warn('[PipService] Failed to invoke open_pip_window:', err);
    }
  }

  public updateStream(peerId: string, stream: MediaStream | null): void {
    const session = this.sessions.get(peerId);
    if (!session) return;

    session.stream = stream;
    try {
      const currentSenders = session.pc.getSenders();
      currentSenders.forEach((sender) => {
        try {
          session.pc.removeTrack(sender);
        } catch {}
      });

      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            session.pc.addTrack(track, stream);
          } catch {}
        });
      }

      // Re-negotiate offer
      session.pc.createOffer().then((offer) => {
        session.pc.setLocalDescription(offer).then(() => {
          session.bc.postMessage({
            type: 'offer',
            sdp: offer.sdp,
          });
        });
      });
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
      try {
        session.bc.postMessage({ type: 'main-closed' });
        session.bc.close();
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
      try {
        session.bc.close();
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

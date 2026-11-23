import { logDiagnostic } from '../core/logger.ts';
import {
  clampSensitivityDb,
  clampVoiceVolume,
  computeNextVoiceMuteDeafen,
  getSavedUserVoiceVolume,
  loadVoicePreferences,
  normalizeVoicePreferences,
  saveUserVoiceVolume,
  saveVoicePreferences,
  type UserVoiceVolumePreference,
  type VoicePreferences,
} from '../core/voice_preferences.ts';
import { AudioContextRecovery } from './audio_context_recovery.ts';
import { listAudioDevices, onAudioDevicesChanged } from './voice_devices.ts';

interface RemotePeerAudioEntry {
  peerId: string;
  stream: MediaStream;
  tracks: MediaStreamTrack[];
  publicKey?: string;
  username?: string;
  source: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  analyser: AnalyserNode;
  pullElement: HTMLAudioElement;
  volume: number;
  muted: boolean;
  speaking: boolean;
  holdUntil: number;
}

export interface VoiceManagerSnapshot {
  inVoice: boolean;
  micMuted: boolean;
  deafened: boolean;
  isLocalSpeaking: boolean;
  isTestGateOpen: boolean;
  inputLevelDb: number;
  effectiveThresholdDb: number;
  micTestActive: boolean;
  preferences: VoicePreferences;
  remoteSpeaking: Record<string, boolean>;
}

const REMOTE_SPEAK_OPEN_DB = -46;
const REMOTE_SPEAK_CLOSE_DB = -51;
const REMOTE_SPEAK_HOLD_MS = 240;

export class VoiceManager {
  private preferences: VoicePreferences = loadVoicePreferences();
  private draftTestPreferences: VoicePreferences | null = null;

  public inVoice = false;
  public micMuted = false;
  public deafened = false;
  public micMutedBeforeDeafen = false;
  public isLocalSpeaking = false;
  public isTestGateOpen = false;
  public inputLevelDb = -100;
  public effectiveThresholdDb = -50;
  public micTestActive = false;

  // Input AudioContext & DSP graph
  private inputCtx: AudioContext | null = null;
  private inputRecovery: AudioContextRecovery | undefined;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private inputGainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletLoaded = false;
  private outboundCallGain: GainNode | null = null;
  private outboundDestination: MediaStreamAudioDestinationNode | null = null;
  private testLoopbackDestination: MediaStreamAudioDestinationNode | null = null;

  // Fallback nodes if AudioWorklet is unavailable
  private fallbackHighPass: BiquadFilterNode | null = null;
  private fallbackAnalyser: AnalyserNode | null = null;
  private fallbackGateGain: GainNode | null = null;
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackNoiseFloorDb = -65;
  private fallbackGateOpen = false;
  private fallbackHoldUntil = 0;

  // Output AudioContext & playback graph
  private outputCtx: AudioContext | null = null;
  private outputRecovery: AudioContextRecovery | undefined;
  private masterGainNode: GainNode | null = null;
  private outputLimiter: DynamicsCompressorNode | null = null;
  private fallbackSinkDest: MediaStreamAudioDestinationNode | null = null;
  private fallbackSinkElement: HTMLAudioElement | null = null;

  // Mic test loopback nodes on outputCtx
  private testPreviewSource: MediaStreamAudioSourceNode | null = null;
  private testPreviewGain: GainNode | null = null;

  // Remote voice peers
  private remotePeers = new Map<string, RemotePeerAudioEntry>();
  private manuallyAdjustedPeers = new Set<string>();
  private remoteSpeakTimer: ReturnType<typeof setInterval> | null = null;
  private remoteSpeakScratch = new Float32Array(256);

  private listeners = new Set<() => void>();
  private cachedSnapshot: VoiceManagerSnapshot | null = null;
  private unsubscribeDevices: (() => void) | null = null;
  private inputSwapGeneration = 0;
  private inputAcquirePromise: Promise<void> | null = null;

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.cachedSnapshot = null;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.warn('[Voice] Listener error:', err);
      }
    });
  }

  public getPreferences(): VoicePreferences {
    return { ...this.preferences };
  }

  private getActiveInputPrefs(): VoicePreferences {
    return this.micTestActive && this.draftTestPreferences
      ? this.draftTestPreferences
      : this.preferences;
  }

  private getActiveOutputPrefs(): VoicePreferences {
    return this.micTestActive && this.draftTestPreferences
      ? this.draftTestPreferences
      : this.preferences;
  }

  public getSnapshot(): VoiceManagerSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    const remoteSpeaking: Record<string, boolean> = {};
    this.remotePeers.forEach((entry, peerId) => {
      remoteSpeaking[peerId] = entry.speaking;
    });
    this.cachedSnapshot = {
      inVoice: this.inVoice,
      micMuted: this.micMuted,
      deafened: this.deafened,
      isLocalSpeaking: this.isLocalSpeaking,
      isTestGateOpen: this.isTestGateOpen,
      inputLevelDb: this.inputLevelDb,
      effectiveThresholdDb: this.effectiveThresholdDb,
      micTestActive: this.micTestActive,
      preferences: { ...this.preferences },
      remoteSpeaking,
    };
    return this.cachedSnapshot;
  }

  private ensureDeviceListener(): void {
    if (this.unsubscribeDevices) return;
    this.unsubscribeDevices = onAudioDevicesChanged(() => {
      void this.handleDevicesChanged();
    });
  }

  private disposeDeviceListener(): void {
    if (this.inVoice || this.micTestActive) return;
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
  }

  private async handleDevicesChanged(): Promise<void> {
    if (!this.inVoice && !this.micTestActive) return;
    try {
      const devices = await listAudioDevices(false);
      const activeIn = this.getActiveInputPrefs();
      const activeOut = this.getActiveOutputPrefs();
      if (
        activeIn.inputDeviceId !== 'default' &&
        !devices.inputs.some((d) => d.deviceId === activeIn.inputDeviceId)
      ) {
        await this.swapMicrophoneInput({ ...activeIn, inputDeviceId: 'default' });
      }
      if (
        activeOut.outputDeviceId !== 'default' &&
        !devices.outputs.some((d) => d.deviceId === activeOut.outputDeviceId)
      ) {
        await this.applyOutputDevice('default');
      }
    } catch {
      // Ignore transient device enumeration failures during plug/unplug.
    }
  }

  private createAudioContext(forCapture: boolean): AudioContext {
    const AudioCtxClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (forCapture) {
      try {
        return new AudioCtxClass({ sampleRate: 48000, latencyHint: 'interactive' });
      } catch {
        return new AudioCtxClass();
      }
    }
    try {
      return new AudioCtxClass({ latencyHint: 'interactive' });
    } catch {
      return new AudioCtxClass();
    }
  }

  private async ensureInputPipeline(prefs: VoicePreferences): Promise<MediaStream> {
    if (!this.inputCtx) {
      this.inputCtx = this.createAudioContext(true);
      this.inputRecovery = new AudioContextRecovery(this.inputCtx, undefined, 'capture');
    }
    this.inputRecovery?.resume();

    if (!this.outboundDestination) {
      this.outboundDestination = this.inputCtx.createMediaStreamDestination();
    }
    if (!this.testLoopbackDestination) {
      this.testLoopbackDestination = this.inputCtx.createMediaStreamDestination();
    }
    if (!this.outboundCallGain) {
      this.outboundCallGain = this.inputCtx.createGain();
      this.outboundCallGain.gain.value = this.inVoice && !this.micMuted ? 1 : 0;
      this.outboundCallGain.connect(this.outboundDestination);
    }

    if (!this.inputGainNode) {
      this.inputGainNode = this.inputCtx.createGain();
      this.inputGainNode.gain.value = clampVoiceVolume(prefs.inputVolume) / 100;
    }

    if (!this.workletNode && !this.fallbackGateGain) {
      await this.setupProcessorNode(
        this.inputCtx,
        this.inputGainNode,
        this.outboundCallGain,
        this.testLoopbackDestination,
        prefs,
      );
    }

    await this.acquireMicrophoneSource(prefs);
    this.syncProcessorParameters(prefs);
    return this.outboundDestination.stream;
  }

  private async setupProcessorNode(
    ctx: AudioContext,
    sourceGain: GainNode,
    callGain: GainNode,
    testDestination: MediaStreamAudioDestinationNode,
    prefs: VoicePreferences,
  ): Promise<void> {
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        if (!this.workletLoaded) {
          await ctx.audioWorklet.addModule('/audio/voice-processor.worklet.js');
          this.workletLoaded = true;
        }
        const node = new AudioWorkletNode(ctx, 'p2sharer-voice-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        node.port.onmessage = (event) => {
          const data = event.data as { levelDb?: number; gateOpen?: boolean; thresholdDb?: number } | null;
          if (!data) return;
          const nextLevel = typeof data.levelDb === 'number' ? Math.round(data.levelDb) : this.inputLevelDb;
          const nextThreshold = typeof data.thresholdDb === 'number'
            ? Math.round(data.thresholdDb)
            : this.effectiveThresholdDb;
          const gateOpen = Boolean(data.gateOpen);
          const nextSpeaking = gateOpen && this.inVoice && !this.micMuted;
          const changed =
            nextSpeaking !== this.isLocalSpeaking ||
            gateOpen !== this.isTestGateOpen ||
            Math.abs(nextLevel - this.inputLevelDb) >= 1 ||
            Math.abs(nextThreshold - this.effectiveThresholdDb) >= 1;
          this.inputLevelDb = nextLevel;
          this.effectiveThresholdDb = nextThreshold;
          this.isTestGateOpen = gateOpen;
          this.isLocalSpeaking = nextSpeaking;
          if (changed) this.notify();
        };
        sourceGain.connect(node);
        node.connect(callGain);
        node.connect(testDestination);
        this.workletNode = node;
        return;
      } catch (err) {
        logDiagnostic('WARN', 'voice.dsp', 'AudioWorklet unavailable; falling back to node-based VAD gate', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Graceful fallback DSP graph when AudioWorklet cannot load.
    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = prefs.noiseSuppressionMode === 'off' ? 10 : 85;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    const gateGain = ctx.createGain();
    gateGain.gain.value = 0;

    sourceGain.connect(highPass);
    highPass.connect(analyser);
    analyser.connect(gateGain);
    gateGain.connect(callGain);
    gateGain.connect(testDestination);

    this.fallbackHighPass = highPass;
    this.fallbackAnalyser = analyser;
    this.fallbackGateGain = gateGain;

    const scratch = new Float32Array(analyser.fftSize);
    this.fallbackTimer = setInterval(() => {
      if (!this.fallbackAnalyser || !this.fallbackGateGain || !this.inputCtx) return;
      const activePrefs = this.getActiveInputPrefs();
      this.fallbackAnalyser.getFloatTimeDomainData(scratch);
      let sq = 0;
      for (let i = 0; i < scratch.length; i += 1) {
        sq += scratch[i] * scratch[i];
      }
      const rms = Math.sqrt(sq / scratch.length);
      const levelDb = Math.max(-100, Math.min(0, rms > 1e-6 ? 20 * Math.log10(rms) : -100));
      if (activePrefs.autoSensitivity) {
        if (levelDb < this.fallbackNoiseFloorDb) {
          this.fallbackNoiseFloorDb = this.fallbackNoiseFloorDb * 0.85 + levelDb * 0.15;
        } else if (!this.fallbackGateOpen && levelDb < this.fallbackNoiseFloorDb + 10) {
          this.fallbackNoiseFloorDb = this.fallbackNoiseFloorDb * 0.99 + levelDb * 0.01;
        }
      }
      const thresholdDb = activePrefs.autoSensitivity
        ? Math.max(-72, Math.min(-26, this.fallbackNoiseFloorDb + 8))
        : activePrefs.sensitivityDb;
      const now = Date.now();
      const processorMuted = this.inVoice && !this.micTestActive && this.micMuted;
      if (processorMuted) {
        this.fallbackGateOpen = false;
      } else if (levelDb >= thresholdDb) {
        this.fallbackGateOpen = true;
        this.fallbackHoldUntil = now + 280;
      } else if (this.fallbackGateOpen && levelDb < thresholdDb - 4 && now > this.fallbackHoldUntil) {
        this.fallbackGateOpen = false;
      }
      const target = !processorMuted && this.fallbackGateOpen ? 1 : 0;
      this.fallbackGateGain.gain.setTargetAtTime(target, this.inputCtx.currentTime, 0.015);
      const roundedLevel = Math.round(levelDb);
      const roundedThreshold = Math.round(thresholdDb);
      const gateOpen = !processorMuted && this.fallbackGateOpen;
      const nextSpeaking = gateOpen && this.inVoice && !this.micMuted;
      const changed =
        nextSpeaking !== this.isLocalSpeaking ||
        gateOpen !== this.isTestGateOpen ||
        Math.abs(roundedLevel - this.inputLevelDb) >= 1 ||
        Math.abs(roundedThreshold - this.effectiveThresholdDb) >= 1;
      this.inputLevelDb = roundedLevel;
      this.effectiveThresholdDb = roundedThreshold;
      this.isTestGateOpen = gateOpen;
      this.isLocalSpeaking = nextSpeaking;
      if (changed) this.notify();
    }, 50);
  }

  private buildAudioConstraints(prefs: VoicePreferences, useExactDevice: boolean): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      echoCancellation: prefs.echoCancellation,
      noiseSuppression: prefs.noiseSuppressionMode !== 'off',
      autoGainControl: prefs.autoGainControl,
      channelCount: 1,
    };
    if (useExactDevice && prefs.inputDeviceId && prefs.inputDeviceId !== 'default') {
      constraints.deviceId = { exact: prefs.inputDeviceId };
    }
    return constraints;
  }

  private async acquireMicrophoneSource(prefs: VoicePreferences): Promise<void> {
    if (!this.inputCtx || !this.inputGainNode) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not supported in this runtime');
    }
    const generation = ++this.inputSwapGeneration;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: this.buildAudioConstraints(prefs, true),
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (
        prefs.inputDeviceId !== 'default' &&
        (name === 'OverconstrainedError' || name === 'NotFoundError')
      ) {
        logDiagnostic('WARN', 'voice.input', 'Selected microphone unavailable; falling back to default', {
          deviceId: prefs.inputDeviceId,
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: this.buildAudioConstraints(prefs, false),
        });
      } else {
        throw err;
      }
    }

    if (generation !== this.inputSwapGeneration || !this.inputCtx || !this.inputGainNode) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.releaseMicSourceOnly();
    this.micStream = stream;
    this.micSource = this.inputCtx.createMediaStreamSource(stream);
    this.micSource.connect(this.inputGainNode);

    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (this.micStream === stream && (this.inVoice || this.micTestActive)) {
          void this.swapMicrophoneInput({ ...this.getActiveInputPrefs(), inputDeviceId: 'default' });
        }
      });
    });
  }

  private releaseMicSourceOnly(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {}
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
  }

  private async swapMicrophoneInput(prefs: VoicePreferences): Promise<void> {
    if (!this.inputCtx || !this.inputGainNode) return;
    if (this.inputAcquirePromise) {
      await this.inputAcquirePromise.catch(() => {});
    }
    this.inputAcquirePromise = this.acquireMicrophoneSource(prefs).catch((err) => {
      logDiagnostic('WARN', 'voice.input', 'Failed to swap microphone input', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await this.inputAcquirePromise;
  }

  private syncProcessorParameters(prefs: VoicePreferences): void {
    const processorMuted = this.inVoice && !this.micTestActive ? this.micMuted : false;
    if (this.outboundCallGain && this.inputCtx) {
      this.outboundCallGain.gain.setTargetAtTime(
        this.inVoice && !this.micMuted ? 1 : 0,
        this.inputCtx.currentTime,
        0.01,
      );
    }
    if (this.inputGainNode && this.inputCtx) {
      this.inputGainNode.gain.setTargetAtTime(
        clampVoiceVolume(prefs.inputVolume) / 100,
        this.inputCtx.currentTime,
        0.015,
      );
    }
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        noiseSuppressionMode: prefs.noiseSuppressionMode,
        autoSensitivity: prefs.autoSensitivity,
        sensitivityDb: clampSensitivityDb(prefs.sensitivityDb),
        muted: processorMuted,
      });
    }
    if (this.fallbackHighPass && this.inputCtx) {
      this.fallbackHighPass.frequency.setTargetAtTime(
        prefs.noiseSuppressionMode === 'off' ? 10 : 85,
        this.inputCtx.currentTime,
        0.02,
      );
    }
    if ((!this.inVoice || this.micMuted) && this.isLocalSpeaking) {
      this.isLocalSpeaking = false;
    }
    if (processorMuted && this.isTestGateOpen) {
      this.isTestGateOpen = false;
    }
  }

  private ensureOutputPipeline(prefs: VoicePreferences): AudioContext {
    if (!this.outputCtx) {
      this.outputCtx = this.createAudioContext(false);
      this.outputRecovery = new AudioContextRecovery(
        this.outputCtx,
        () => {
          this.remotePeers.forEach((entry) => {
            if (entry.pullElement.paused) void entry.pullElement.play()?.catch(() => {});
          });
          if (this.fallbackSinkElement?.paused) {
            void this.fallbackSinkElement.play()?.catch(() => {});
          }
        },
        'playback',
      );

      this.masterGainNode = this.outputCtx.createGain();
      this.outputLimiter = this.outputCtx.createDynamicsCompressor();
      this.outputLimiter.threshold.value = -3;
      this.outputLimiter.knee.value = 12;
      this.outputLimiter.ratio.value = 6;
      this.outputLimiter.attack.value = 0.003;
      this.outputLimiter.release.value = 0.15;

      this.masterGainNode.connect(this.outputLimiter);

      const supportsContextSinkId =
        'setSinkId' in this.outputCtx &&
        typeof (this.outputCtx as AudioContext & { setSinkId?: unknown }).setSinkId === 'function';
      if (supportsContextSinkId) {
        this.outputLimiter.connect(this.outputCtx.destination);
      } else {
        this.fallbackSinkDest = this.outputCtx.createMediaStreamDestination();
        this.outputLimiter.connect(this.fallbackSinkDest);
        const sinkEl = document.createElement('audio');
        sinkEl.autoplay = true;
        sinkEl.setAttribute('playsinline', 'true');
        sinkEl.hidden = true;
        sinkEl.srcObject = this.fallbackSinkDest.stream;
        document.body.appendChild(sinkEl);
        this.fallbackSinkElement = sinkEl;
        void sinkEl.play()?.catch(() => {});
      }
      void this.applyOutputDevice(prefs.outputDeviceId);
    }

    this.syncMasterOutputGain(prefs);
    this.outputRecovery?.resume();
    return this.outputCtx;
  }

  private syncMasterOutputGain(prefs: VoicePreferences): void {
    if (!this.outputCtx || !this.masterGainNode) return;
    const gainValue = this.deafened ? 0 : clampVoiceVolume(prefs.outputVolume) / 100;
    this.masterGainNode.gain.setTargetAtTime(gainValue, this.outputCtx.currentTime, 0.015);
  }

  public async applyOutputDevice(deviceId: string): Promise<void> {
    if (!this.outputCtx) return;
    const sinkId = !deviceId || deviceId === 'default' ? '' : deviceId;
    const ctxWithSink = this.outputCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctxWithSink.setSinkId === 'function') {
      try {
        await ctxWithSink.setSinkId(sinkId);
      } catch (err) {
        if (sinkId !== '') {
          logDiagnostic('WARN', 'voice.output', 'Selected output device unavailable; reverting to default', {
            deviceId: sinkId,
            error: err instanceof Error ? err.message : String(err),
          });
          await ctxWithSink.setSinkId('').catch(() => {});
        }
      }
      return;
    }
    const elWithSink = this.fallbackSinkElement as (HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (elWithSink && typeof elWithSink.setSinkId === 'function') {
      try {
        await elWithSink.setSinkId(sinkId);
      } catch {
        if (sinkId !== '') await elWithSink.setSinkId('').catch(() => {});
      }
    }
  }

  public async joinVoice(): Promise<MediaStream> {
    this.ensureDeviceListener();
    this.ensureOutputPipeline(this.getActiveOutputPrefs());
    const outbound = await this.ensureInputPipeline(this.getActiveInputPrefs());
    this.inVoice = true;
    this.syncProcessorParameters(this.getActiveInputPrefs());
    this.syncMasterOutputGain(this.getActiveOutputPrefs());
    this.notify();
    return outbound;
  }

  public leaveVoice(): void {
    this.inVoice = false;
    this.micMuted = false;
    this.deafened = false;
    this.micMutedBeforeDeafen = false;
    this.isLocalSpeaking = false;

    for (const peerId of Array.from(this.remotePeers.keys())) {
      this.detachRemoteVoice(peerId);
    }

    if (!this.micTestActive) {
      this.teardownInputPipeline();
      this.teardownOutputPipeline();
      this.disposeDeviceListener();
    } else {
      this.syncProcessorParameters(this.getActiveInputPrefs());
      this.syncMasterOutputGain(this.getActiveOutputPrefs());
    }
    this.notify();
  }

  private teardownInputPipeline(): void {
    this.inputSwapGeneration++;
    this.releaseMicSourceOnly();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }
    this.workletLoaded = false;
    try {
      this.fallbackHighPass?.disconnect();
    } catch {}
    try {
      this.fallbackAnalyser?.disconnect();
    } catch {}
    try {
      this.fallbackGateGain?.disconnect();
    } catch {}
    this.fallbackHighPass = null;
    this.fallbackAnalyser = null;
    this.fallbackGateGain = null;

    try {
      this.inputGainNode?.disconnect();
    } catch {}
    try {
      this.outboundCallGain?.disconnect();
    } catch {}
    this.inputGainNode = null;
    this.outboundCallGain = null;
    this.outboundDestination = null;
    this.testLoopbackDestination = null;

    this.inputRecovery?.dispose();
    this.inputRecovery = undefined;
    if (this.inputCtx) {
      try {
        void this.inputCtx.close().catch(() => {});
      } catch {}
      this.inputCtx = null;
    }
    this.inputLevelDb = -100;
    this.isLocalSpeaking = false;
    this.isTestGateOpen = false;
  }

  private teardownOutputPipeline(): void {
    if (this.remoteSpeakTimer) {
      clearInterval(this.remoteSpeakTimer);
      this.remoteSpeakTimer = null;
    }
    this.disconnectTestPreviewNodes();
    if (this.fallbackSinkElement) {
      this.fallbackSinkElement.pause();
      this.fallbackSinkElement.srcObject = null;
      this.fallbackSinkElement.remove();
      this.fallbackSinkElement = null;
    }
    this.fallbackSinkDest = null;
    try {
      this.masterGainNode?.disconnect();
    } catch {}
    try {
      this.outputLimiter?.disconnect();
    } catch {}
    this.masterGainNode = null;
    this.outputLimiter = null;
    this.outputRecovery?.dispose();
    this.outputRecovery = undefined;
    if (this.outputCtx) {
      try {
        void this.outputCtx.close().catch(() => {});
      } catch {}
      this.outputCtx = null;
    }
  }

  private disconnectTestPreviewNodes(): void {
    try {
      this.testPreviewSource?.disconnect();
    } catch {}
    try {
      this.testPreviewGain?.disconnect();
    } catch {}
    this.testPreviewSource = null;
    this.testPreviewGain = null;
  }

  public async startMicTest(draftPrefs?: VoicePreferences): Promise<void> {
    this.draftTestPreferences = draftPrefs ? normalizeVoicePreferences(draftPrefs) : null;
    this.micTestActive = true;
    this.ensureDeviceListener();
    const activeIn = this.getActiveInputPrefs();
    const activeOut = this.getActiveOutputPrefs();
    await this.ensureInputPipeline(activeIn);
    const outCtx = this.ensureOutputPipeline(activeOut);
    await this.applyOutputDevice(activeOut.outputDeviceId);

    this.disconnectTestPreviewNodes();
    if (this.outputLimiter && this.testLoopbackDestination) {
      this.testPreviewSource = outCtx.createMediaStreamSource(this.testLoopbackDestination.stream);
      this.testPreviewGain = outCtx.createGain();
      this.testPreviewGain.gain.value = clampVoiceVolume(activeOut.outputVolume) / 100;
      this.testPreviewSource.connect(this.testPreviewGain);
      this.testPreviewGain.connect(this.outputLimiter);
    }
    this.syncProcessorParameters(activeIn);
    this.notify();
  }

  public async updateMicTest(draftPrefs: VoicePreferences): Promise<void> {
    if (!this.micTestActive) return;
    const prev = this.getActiveInputPrefs();
    const next = normalizeVoicePreferences(draftPrefs);
    this.draftTestPreferences = next;

    this.syncProcessorParameters(next);
    if (this.testPreviewGain && this.outputCtx) {
      this.testPreviewGain.gain.setTargetAtTime(
        clampVoiceVolume(next.outputVolume) / 100,
        this.outputCtx.currentTime,
        0.015,
      );
    }
    this.syncMasterOutputGain(next);

    if (prev.outputDeviceId !== next.outputDeviceId) {
      await this.applyOutputDevice(next.outputDeviceId);
    }
    if (
      prev.inputDeviceId !== next.inputDeviceId ||
      prev.echoCancellation !== next.echoCancellation ||
      prev.autoGainControl !== next.autoGainControl
    ) {
      await this.swapMicrophoneInput(next);
    }
    this.notify();
  }

  public stopMicTest(): void {
    if (!this.micTestActive) return;
    this.micTestActive = false;
    this.draftTestPreferences = null;
    this.disconnectTestPreviewNodes();

    if (!this.inVoice) {
      this.teardownInputPipeline();
      if (this.remotePeers.size === 0) {
        this.teardownOutputPipeline();
      }
      this.disposeDeviceListener();
    } else {
      this.syncProcessorParameters(this.preferences);
      this.syncMasterOutputGain(this.preferences);
      void this.applyOutputDevice(this.preferences.outputDeviceId);
      void this.swapMicrophoneInput(this.preferences);
    }
    this.notify();
  }

  public toggleMicMute(): { micMuted: boolean; deafened: boolean; autoUndeafened: boolean } {
    const wasDeafened = this.deafened;
    const next = computeNextVoiceMuteDeafen(
      {
        micMuted: this.micMuted,
        deafened: this.deafened,
        micMutedBeforeDeafen: this.micMutedBeforeDeafen,
      },
      'toggleMute',
    );
    this.micMuted = next.micMuted;
    this.deafened = next.deafened;
    this.micMutedBeforeDeafen = next.micMutedBeforeDeafen;
    this.syncProcessorParameters(this.getActiveInputPrefs());
    this.syncMasterOutputGain(this.getActiveOutputPrefs());
    this.notify();
    return {
      micMuted: this.micMuted,
      deafened: this.deafened,
      autoUndeafened: wasDeafened && !this.deafened,
    };
  }

  public toggleDeafen(): { micMuted: boolean; deafened: boolean } {
    const next = computeNextVoiceMuteDeafen(
      {
        micMuted: this.micMuted,
        deafened: this.deafened,
        micMutedBeforeDeafen: this.micMutedBeforeDeafen,
      },
      'toggleDeafen',
    );
    this.micMuted = next.micMuted;
    this.deafened = next.deafened;
    this.micMutedBeforeDeafen = next.micMutedBeforeDeafen;
    this.syncProcessorParameters(this.getActiveInputPrefs());
    this.syncMasterOutputGain(this.getActiveOutputPrefs());
    this.notify();
    return { micMuted: this.micMuted, deafened: this.deafened };
  }

  public async applyPreferences(nextPrefs: VoicePreferences, persist = true): Promise<void> {
    const prev = this.preferences;
    const normalized = persist ? saveVoicePreferences(nextPrefs) : normalizeVoicePreferences(nextPrefs);
    this.preferences = normalized;

    if (this.inVoice || this.micTestActive) {
      const activeIn = this.getActiveInputPrefs();
      const activeOut = this.getActiveOutputPrefs();
      this.syncProcessorParameters(activeIn);
      this.syncMasterOutputGain(activeOut);

      if (prev.outputDeviceId !== activeOut.outputDeviceId) {
        await this.applyOutputDevice(activeOut.outputDeviceId);
      }
      if (
        prev.inputDeviceId !== activeIn.inputDeviceId ||
        prev.echoCancellation !== activeIn.echoCancellation ||
        prev.autoGainControl !== activeIn.autoGainControl
      ) {
        await this.swapMicrophoneInput(activeIn);
      }
    }
    this.notify();
  }

  public attachRemoteVoice(
    peerId: string,
    stream: MediaStream,
    publicKey?: string,
    username?: string,
  ): void {
    const tracks = stream.getAudioTracks().filter((track) => track.readyState !== 'ended');
    if (tracks.length === 0) return;

    const ctx = this.ensureOutputPipeline(this.getActiveOutputPrefs());
    if (!this.masterGainNode) return;

    const existing = this.remotePeers.get(peerId);
    if (
      existing &&
      existing.tracks.length === tracks.length &&
      tracks.every((t) => existing.tracks.includes(t))
    ) {
      this.refreshRemotePeerIdentity(peerId, publicKey, username);
      if (existing.pullElement.paused) void existing.pullElement.play()?.catch(() => {});
      return;
    }

    if (existing) {
      this.detachRemoteVoice(peerId);
    }

    const saved = getSavedUserVoiceVolume(publicKey, username);
    const audioStream = new MediaStream(tracks);
    const source = ctx.createMediaStreamSource(audioStream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = saved.muted ? 0 : clampVoiceVolume(saved.volume) / 100;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(this.masterGainNode);

    const pullElement = document.createElement('audio');
    pullElement.autoplay = true;
    pullElement.setAttribute('playsinline', 'true');
    pullElement.volume = 0;
    pullElement.hidden = true;
    pullElement.srcObject = audioStream;
    document.body.appendChild(pullElement);
    void pullElement.play()?.catch(() => {});

    this.remotePeers.set(peerId, {
      peerId,
      stream,
      tracks,
      publicKey,
      username,
      source,
      gainNode,
      analyser,
      pullElement,
      volume: saved.volume,
      muted: saved.muted,
      speaking: false,
      holdUntil: 0,
    });

    this.ensureRemoteSpeakTimer();
    this.notify();
  }

  public refreshRemotePeerIdentity(peerId: string, publicKey?: string, username?: string): void {
    const entry = this.remotePeers.get(peerId);
    if (!entry) return;
    if (publicKey && entry.publicKey !== publicKey) {
      entry.publicKey = publicKey;
      if (!this.manuallyAdjustedPeers.has(peerId)) {
        const saved = getSavedUserVoiceVolume(publicKey, username ?? entry.username);
        entry.volume = saved.volume;
        entry.muted = saved.muted;
        if (this.outputCtx) {
          entry.gainNode.gain.setTargetAtTime(
            saved.muted ? 0 : saved.volume / 100,
            this.outputCtx.currentTime,
            0.015,
          );
        }
      }
    }
    if (username) {
      entry.username = username;
    }
  }

  public detachRemoteVoice(peerId: string): void {
    const entry = this.remotePeers.get(peerId);
    if (!entry) return;
    entry.pullElement.pause();
    entry.pullElement.srcObject = null;
    entry.pullElement.remove();
    try {
      entry.source.disconnect();
    } catch {}
    try {
      entry.gainNode.disconnect();
    } catch {}
    try {
      entry.analyser.disconnect();
    } catch {}
    this.remotePeers.delete(peerId);
    this.manuallyAdjustedPeers.delete(peerId);

    if (this.remotePeers.size === 0 && this.remoteSpeakTimer) {
      clearInterval(this.remoteSpeakTimer);
      this.remoteSpeakTimer = null;
    }
    this.notify();
  }

  public setRemotePeerVolume(
    peerId: string,
    volume: number,
    muted: boolean,
    publicKey?: string,
    username?: string,
  ): UserVoiceVolumePreference {
    const entry = this.remotePeers.get(peerId);
    const resolvedKey = publicKey || entry?.publicKey;
    const resolvedName = username || entry?.username;
    const saved = saveUserVoiceVolume(resolvedKey, resolvedName, volume, muted);
    this.manuallyAdjustedPeers.add(peerId);

    if (entry && this.outputCtx) {
      entry.volume = saved.volume;
      entry.muted = saved.muted;
      entry.gainNode.gain.setTargetAtTime(
        saved.muted ? 0 : saved.volume / 100,
        this.outputCtx.currentTime,
        0.015,
      );
      if (entry.pullElement.paused && !saved.muted && saved.volume > 0) {
        void entry.pullElement.play()?.catch(() => {});
      }
    }
    this.notify();
    return saved;
  }

  public getRemotePeerVolume(
    peerId: string,
    publicKey?: string,
    username?: string,
  ): UserVoiceVolumePreference {
    const entry = this.remotePeers.get(peerId);
    if (entry && this.manuallyAdjustedPeers.has(peerId)) {
      return { volume: entry.volume, muted: entry.muted };
    }
    if (entry) {
      return { volume: entry.volume, muted: entry.muted };
    }
    return getSavedUserVoiceVolume(publicKey, username);
  }

  private ensureRemoteSpeakTimer(): void {
    if (this.remoteSpeakTimer) return;
    this.remoteSpeakTimer = setInterval(() => {
      if (this.remotePeers.size === 0) return;
      const now = Date.now();
      let changed = false;
      for (const entry of this.remotePeers.values()) {
        if (entry.muted || entry.volume === 0 || this.deafened) {
          if (entry.speaking) {
            entry.speaking = false;
            changed = true;
          }
          continue;
        }
        entry.analyser.getFloatTimeDomainData(this.remoteSpeakScratch);
        let sq = 0;
        for (let i = 0; i < this.remoteSpeakScratch.length; i += 1) {
          sq += this.remoteSpeakScratch[i] * this.remoteSpeakScratch[i];
        }
        const rms = Math.sqrt(sq / this.remoteSpeakScratch.length);
        const levelDb = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
        let nextSpeaking = entry.speaking;
        if (levelDb >= REMOTE_SPEAK_OPEN_DB) {
          nextSpeaking = true;
          entry.holdUntil = now + REMOTE_SPEAK_HOLD_MS;
        } else if (entry.speaking && levelDb < REMOTE_SPEAK_CLOSE_DB && now > entry.holdUntil) {
          nextSpeaking = false;
        }
        if (nextSpeaking !== entry.speaking) {
          entry.speaking = nextSpeaking;
          changed = true;
        }
      }
      if (changed) this.notify();
    }, 80);
  }
}

export const voiceManager = new VoiceManager();

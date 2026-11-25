// Zero-GC AudioWorklet processor providing spectral noise suppression and sensitivity gating.
const FFT_SIZE = 256;
const HOP_SIZE = 128;
const NUM_BINS = (FFT_SIZE >> 1) + 1;

function createHannWindow(size) {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return win;
}

function createBitReversedIndices(size) {
  const bits = Math.round(Math.log2(size));
  const rev = new Uint16Array(size);
  for (let i = 0; i < size; i += 1) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return rev;
}

function createTwiddleTables(size) {
  const half = size >> 1;
  const cosTable = new Float32Array(half);
  const sinTable = new Float32Array(half);
  for (let i = 0; i < half; i += 1) {
    const angle = (-2 * Math.PI * i) / size;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }
  return { cosTable, sinTable };
}

class VoiceNoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.noiseSuppressionMode = 'standard';
    this.autoSensitivity = true;
    this.sensitivityDb = -50;
    this.muted = false;
    this.targetInputGain = 1;
    this.smoothedInputGain = 1;

    // Adaptive speech auto-leveler calibrated for natural speech headroom (~ -20 dBFS RMS)
    // plus linear peak-envelope limiting so plosives never clip or distort.
    this.speechRms = 0.05;
    this.normalizerGain = 2.2;
    this.limiterGain = 1.0;

    // 2nd-order Butterworth high-pass @ ~85 Hz (recalculated when sampleRate differs).
    this.hpB0 = 1;
    this.hpB1 = 0;
    this.hpB2 = 0;
    this.hpA1 = 0;
    this.hpA2 = 0;
    this.hpX1 = 0;
    this.hpX2 = 0;
    this.hpY1 = 0;
    this.hpY2 = 0;
    this.updateHighPassCoeffs(sampleRate || 48000, 95);

    // Pre-allocated STFT / overlap-add buffers.
    this.window = createHannWindow(FFT_SIZE);
    this.bitRev = createBitReversedIndices(FFT_SIZE);
    const twiddles = createTwiddleTables(FFT_SIZE);
    this.cosTable = twiddles.cosTable;
    this.sinTable = twiddles.sinTable;

    this.inputRing = new Float32Array(FFT_SIZE);
    this.outputAccum = new Float32Array(FFT_SIZE);
    this.fftRe = new Float32Array(FFT_SIZE);
    this.fftIm = new Float32Array(FFT_SIZE);

    this.noisePsd = new Float32Array(NUM_BINS);
    this.noisePsd.fill(1e-7);
    this.minPsdCurr = new Float32Array(NUM_BINS);
    this.minPsdCurr.fill(1e6);
    this.minPsdPrev = new Float32Array(NUM_BINS);
    this.minPsdPrev.fill(1e6);
    this.minWindowFrames = 0;
    this.prevHighBandEnergy = 1e-6;
    this.prevPostSnr = new Float32Array(NUM_BINS);
    this.prevGain = new Float32Array(NUM_BINS);
    this.prevGain.fill(1);
    this.binGain = new Float32Array(NUM_BINS);
    this.smoothedBinGain = new Float32Array(NUM_BINS);
    this.magSq = new Float32Array(NUM_BINS);
    this.noiseInitFrames = 0;
    this.lastSpeechBandRatio = 1;
    this.lastSpeechSnrDb = 20;

    // VAD / Gate state.
    this.noiseFloorDb = -65;
    this.minFloorDbCurr = 0;
    this.minFloorDbPrev = -65;
    this.minFloorFrames = 0;
    this.onsetFrames = 0;
    this.gateOpen = false;
    this.holdRemainingSamples = 0;
    this.gateEnvelope = 0;
    this.meterAccumulator = 0;
    this.meterPeakSq = 0;
    this.meterSamples = 0;
    this.lastPublishedThresholdDb = -50;

    const sr = sampleRate || 48000;
    this.attackCoeff = 1 - Math.exp(-1 / (0.01 * sr));
    this.releaseCoeff = 1 - Math.exp(-1 / (0.18 * sr));
    this.holdSamples = Math.round(0.28 * sr);
    this.meterIntervalSamples = Math.max(HOP_SIZE, Math.round(0.05 * sr));

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (
        data.noiseSuppressionMode === 'off' ||
        data.noiseSuppressionMode === 'standard' ||
        data.noiseSuppressionMode === 'high'
      ) {
        this.noiseSuppressionMode = data.noiseSuppressionMode;
        this.updateHighPassCoeffs(sampleRate || 48000, data.noiseSuppressionMode === 'high' ? 135 : 95);
      }
      if (typeof data.autoSensitivity === 'boolean') {
        this.autoSensitivity = data.autoSensitivity;
      }
      if (typeof data.sensitivityDb === 'number' && Number.isFinite(data.sensitivityDb)) {
        this.sensitivityDb = Math.max(-100, Math.min(0, data.sensitivityDb));
      }
      if (typeof data.muted === 'boolean') {
        this.muted = data.muted;
      }
      if (typeof data.inputGain === 'number' && Number.isFinite(data.inputGain)) {
        this.targetInputGain = Math.max(0, Math.min(2, data.inputGain));
      }
    };
  }

  updateHighPassCoeffs(sr, cutoffHz) {
    const w0 = (2 * Math.PI * cutoffHz) / sr;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;
    const a0 = 1 + alpha;
    this.hpB0 = ((1 + cosW0) * 0.5) / a0;
    this.hpB1 = -(1 + cosW0) / a0;
    this.hpB2 = ((1 + cosW0) * 0.5) / a0;
    this.hpA1 = (-2 * cosW0) / a0;
    this.hpA2 = (1 - alpha) / a0;
  }

  runFft(re, im, inverse) {
    const n = FFT_SIZE;
    for (let i = 0; i < n; i += 1) {
      const j = this.bitRev[i];
      if (i < j) {
        const tr = re[i];
        const ti = im[i];
        re[i] = re[j];
        im[i] = im[j];
        re[j] = tr;
        im[j] = ti;
      }
    }

    const sign = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k += 1) {
          const tableIdx = k * step;
          const wr = this.cosTable[tableIdx];
          const wi = sign * this.sinTable[tableIdx];
          const even = i + k;
          const odd = even + half;
          const tr = wr * re[odd] - wi * im[odd];
          const ti = wr * im[odd] + wi * re[odd];
          re[odd] = re[even] - tr;
          im[odd] = im[even] - ti;
          re[even] += tr;
          im[even] += ti;
        }
      }
    }

    if (inverse) {
      const scale = 1 / n;
      for (let i = 0; i < n; i += 1) {
        re[i] *= scale;
        im[i] *= scale;
      }
    }
  }

  applySpectralSuppression(frame) {
    const win = this.window;
    const re = this.fftRe;
    const im = this.fftIm;

    // Shift left by HOP_SIZE and append new 128 samples.
    this.inputRing.copyWithin(0, HOP_SIZE);
    this.inputRing.set(frame, HOP_SIZE);

    for (let i = 0; i < FFT_SIZE; i += 1) {
      re[i] = this.inputRing[i] * win[i];
      im[i] = 0;
    }

    this.runFft(re, im, false);

    const isHigh = this.noiseSuppressionMode === 'high';
    const baseOversub = isHigh ? 3.8 : 1.8;
    const gainFloor = isHigh ? 0.008 : 0.05;
    const alpha = isHigh ? 0.90 : 0.92;
    const gainExp = isHigh ? 1.35 : 1.0;

    let frameEnergy = 0;
    let noiseEnergy = 0;
    let speechBandEnergy = 0;
    let speechNoiseEnergy = 0;
    let highBandEnergy = 0;
    let totalAudibleEnergy = 0;
    for (let k = 0; k < NUM_BINS; k += 1) {
      const m2 = re[k] * re[k] + im[k] * im[k];
      this.magSq[k] = m2;
      frameEnergy += m2;
      noiseEnergy += this.noisePsd[k];
      if (k >= 1 && k <= 96) {
        totalAudibleEnergy += m2;
      }
      // Core voice band (~187 Hz - 3.4 kHz at 48 kHz) vs high click/hiss band (> 3.5 kHz).
      if (k >= 1 && k <= 18) {
        speechBandEnergy += m2;
        speechNoiseEnergy += this.noisePsd[k];
      } else if (k >= 19 && k <= 96) {
        highBandEnergy += m2;
      }
    }

    const initPhase = this.noiseInitFrames < 15;
    if (initPhase) {
      this.noiseInitFrames += 1;
    }

    // Two-window minimum-statistics tracker (~0.6s per sub-window) continuously adapts to
    // stationary fan/AC noise even if the fan starts mid-call or while the gate is open.
    this.minWindowFrames += 1;
    const rotateMinWindow = this.minWindowFrames >= 225;
    if (rotateMinWindow) {
      this.minWindowFrames = 0;
    }

    const likelySpeech = !initPhase && (this.gateOpen || frameEnergy > noiseEnergy * 2.5);
    const impulseClick =
      isHigh &&
      !initPhase &&
      highBandEnergy > this.prevHighBandEnergy * 4.5 &&
      highBandEnergy > speechBandEnergy * 0.9;
    this.prevHighBandEnergy = this.prevHighBandEnergy * 0.85 + highBandEnergy * 0.15;

    for (let k = 0; k < NUM_BINS; k += 1) {
      const m2 = this.magSq[k];
      let psd = this.noisePsd[k];

      if (m2 < this.minPsdCurr[k]) {
        this.minPsdCurr[k] = m2;
      }
      if (rotateMinWindow) {
        this.minPsdPrev[k] = this.minPsdCurr[k];
        this.minPsdCurr[k] = m2;
      }

      if (initPhase) {
        psd = Math.max(1e-8, psd * 0.65 + m2 * 0.35);
      } else {
        const minEst = Math.min(this.minPsdPrev[k], this.minPsdCurr[k]) * 1.45;
        if (m2 < psd) {
          psd = Math.max(1e-8, psd * 0.88 + m2 * 0.12);
        } else if (minEst < 1e5 && minEst > psd) {
          // Stationary floor rose (e.g. fan turned on): pull noisePsd up reliably even if gate is open.
          psd = Math.max(1e-8, psd * 0.96 + minEst * 0.04);
        } else if (!likelySpeech) {
          psd = Math.max(1e-8, psd * 0.985 + m2 * 0.015);
        }
      }
      this.noisePsd[k] = psd;

      const oversub = isHigh && (k <= 1 || k >= 24) ? 5.5 : baseOversub;
      const postSnr = Math.min(100, m2 / (psd * oversub + 1e-10));
      const priorSnr = Math.max(
        0,
        alpha * (this.prevGain[k] * this.prevGain[k] * this.prevPostSnr[k]) +
          (1 - alpha) * Math.max(0, postSnr - 1),
      );
      let gain = priorSnr / (1 + priorSnr);
      if (gainExp !== 1.0) {
        gain = Math.pow(gain, gainExp);
      }
      if (impulseClick && k >= 19) {
        gain *= 0.12;
      }
      if (gain < gainFloor) gain = gainFloor;

      this.prevPostSnr[k] = postSnr;
      this.prevGain[k] = gain;
      this.binGain[k] = gain;
    }

    this.lastSpeechBandRatio = totalAudibleEnergy > 1e-10 ? speechBandEnergy / totalAudibleEnergy : 0;
    this.lastSpeechSnrDb = 10 * Math.log10((speechBandEnergy + 1e-10) / (speechNoiseEnergy + 1e-10));

    if (isHigh) {
      this.smoothedBinGain[0] = this.binGain[0];
      this.smoothedBinGain[NUM_BINS - 1] = this.binGain[NUM_BINS - 1];
      for (let k = 1; k < NUM_BINS - 1; k += 1) {
        this.smoothedBinGain[k] =
          0.25 * this.binGain[k - 1] + 0.5 * this.binGain[k] + 0.25 * this.binGain[k + 1];
      }
    } else {
      this.smoothedBinGain.set(this.binGain);
    }

    // Apply symmetric gain to complex FFT bins.
    re[0] *= this.smoothedBinGain[0];
    im[0] *= this.smoothedBinGain[0];
    const nyquist = NUM_BINS - 1;
    re[nyquist] *= this.smoothedBinGain[nyquist];
    im[nyquist] *= this.smoothedBinGain[nyquist];
    for (let k = 1; k < nyquist; k += 1) {
      const g = this.smoothedBinGain[k];
      re[k] *= g;
      im[k] *= g;
      const mirror = FFT_SIZE - k;
      re[mirror] *= g;
      im[mirror] *= g;
    }

    this.runFft(re, im, true);

    // Hann window OLA with 50% overlap (sum of w^2 = 0.75 * 1? wait: Hann w[n] * w[n]
    // with 50% overlap sums to 0.75? Wait: Hann without extra window sums to 1.0,
    // squared Hann with 50% overlap sums to 0.75 -> scale by 1 / 0.75 = 1.333333, OR
    // analysis-only Hann + rectangular synthesis sums to 1.0 directly.
    // Let's use rectangular synthesis window with 50% Hann analysis -> exact unity gain 1.0!).
    this.outputAccum.copyWithin(0, HOP_SIZE);
    this.outputAccum.fill(0, HOP_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      this.outputAccum[i] += re[i];
    }
    for (let i = 0; i < HOP_SIZE; i += 1) {
      frame[i] = this.outputAccum[i];
    }
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];
    if (!outputChannels || outputChannels.length === 0) return true;

    const outChannel0 = outputChannels[0];
    const len = outChannel0.length;

    if (!inputChannels || inputChannels.length === 0 || !inputChannels[0]) {
      for (let c = 0; c < outputChannels.length; c += 1) {
        outputChannels[c].fill(0);
      }
      return true;
    }

    const inChannel0 = inputChannels[0];
    const numIn = inputChannels.length;
    const useSuppression = this.noiseSuppressionMode !== 'off';

    // Downmix multi-channel mic input to mono into outChannel0 temporarily.
    if (numIn === 1) {
      outChannel0.set(inChannel0);
    } else {
      const invChannels = 1 / numIn;
      for (let i = 0; i < len; i += 1) {
        let sum = 0;
        for (let c = 0; c < numIn; c += 1) {
          sum += inputChannels[c][i];
        }
        outChannel0[i] = sum * invChannels;
      }
    }

    if (useSuppression) {
      // High-pass filter (~85 Hz) removes DC offset and low rumble.
      const b0 = this.hpB0;
      const b1 = this.hpB1;
      const b2 = this.hpB2;
      const a1 = this.hpA1;
      const a2 = this.hpA2;
      let x1 = this.hpX1;
      let x2 = this.hpX2;
      let y1 = this.hpY1;
      let y2 = this.hpY2;

      for (let i = 0; i < len; i += 1) {
        const x0 = outChannel0[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        outChannel0[i] = y0;
      }
      this.hpX1 = x1;
      this.hpX2 = x2;
      this.hpY1 = y1;
      this.hpY2 = y2;

      if (len === HOP_SIZE) {
        this.applySpectralSuppression(outChannel0);
      }
    }

    // Compute block RMS in dBFS for VAD & level meter.
    let sqSum = 0;
    for (let i = 0; i < len; i += 1) {
      const s = outChannel0[i];
      sqSum += s * s;
    }
    const rms = Math.sqrt(sqSum / Math.max(1, len));
    const levelDb = Math.max(-100, Math.min(0, rms > 1e-6 ? 20 * Math.log10(rms) : -100));

    if (this.autoSensitivity) {
      if (levelDb < this.minFloorDbCurr) {
        this.minFloorDbCurr = levelDb;
      }
      this.minFloorFrames += 1;
      if (this.minFloorFrames >= 250) {
        this.minFloorDbPrev = this.minFloorDbCurr;
        this.minFloorDbCurr = levelDb;
        this.minFloorFrames = 0;
      }
      const stationaryFloorDb = Math.min(this.minFloorDbPrev, this.minFloorDbCurr);

      if (levelDb < this.noiseFloorDb) {
        this.noiseFloorDb = this.noiseFloorDb * 0.85 + levelDb * 0.15;
      } else if (stationaryFloorDb > this.noiseFloorDb) {
        this.noiseFloorDb = this.noiseFloorDb * 0.96 + stationaryFloorDb * 0.04;
      } else if (!this.gateOpen && levelDb < this.noiseFloorDb + 10) {
        this.noiseFloorDb = this.noiseFloorDb * 0.992 + levelDb * 0.008;
      }
    }

    const autoMarginDb = this.noiseSuppressionMode === 'high' ? 11 : 8;
    const thresholdDb = this.autoSensitivity
      ? Math.max(-72, Math.min(-24, this.noiseFloorDb + autoMarginDb))
      : this.sensitivityDb;
    this.lastPublishedThresholdDb = thresholdDb;

    const isHigh = this.noiseSuppressionMode === 'high';
    const requiredOnsetFrames = !useSuppression ? 1 : isHigh ? 4 : 2;
    const minSpeechBandRatio = !useSuppression ? 0 : isHigh ? 0.42 : 0.28;
    const minSpeechSnrDb = !useSuppression ? -100 : isHigh ? 5.5 : 2.5;
    const speechLike =
      !useSuppression ||
      (this.lastSpeechBandRatio >= minSpeechBandRatio && this.lastSpeechSnrDb >= minSpeechSnrDb);

    if (this.muted) {
      this.gateOpen = false;
      this.onsetFrames = 0;
      this.holdRemainingSamples = 0;
    } else if (levelDb >= thresholdDb && speechLike) {
      this.onsetFrames = Math.min(requiredOnsetFrames, this.onsetFrames + 1);
      if (this.gateOpen || this.onsetFrames >= requiredOnsetFrames) {
        this.gateOpen = true;
        this.holdRemainingSamples = this.holdSamples;
      }
    } else if (this.gateOpen) {
      if (levelDb >= thresholdDb - 4 && speechLike) {
        this.holdRemainingSamples = this.holdSamples;
      } else if (this.holdRemainingSamples > len) {
        this.holdRemainingSamples -= len;
      } else {
        this.holdRemainingSamples = 0;
        this.onsetFrames = 0;
        this.gateOpen = false;
      }
    } else {
      this.onsetFrames = 0;
    }

    let blockPeak = 0;
    for (let i = 0; i < len; i += 1) {
      const a = outChannel0[i] < 0 ? -outChannel0[i] : outChannel0[i];
      if (a > blockPeak) blockPeak = a;
    }

    if (!this.muted && this.gateOpen && rms >= 0.012 && levelDb >= thresholdDb + 3) {
      this.speechRms = this.speechRms * 0.97 + rms * 0.03;
      const targetSpeechRms = 0.10; // ~ -20 dBFS conversational RMS (leaves ~12 dB headroom for speech peaks)
      let desiredGain = Math.max(0.5, Math.min(4.2, targetSpeechRms / Math.max(this.speechRms, 0.012)));
      if (blockPeak * desiredGain > 0.72 && blockPeak > 1e-4) {
        desiredGain = Math.max(0.5, 0.72 / blockPeak);
      }
      const adaptCoeff = desiredGain < this.normalizerGain ? 0.12 : 0.012;
      this.normalizerGain += (desiredGain - this.normalizerGain) * adaptCoeff;
    } else if (!this.muted && this.gateOpen && blockPeak * this.normalizerGain > 0.78 && blockPeak > 1e-4) {
      const capGain = Math.max(0.5, 0.78 / blockPeak);
      this.normalizerGain += (capGain - this.normalizerGain) * 0.35;
    }

    this.smoothedInputGain += (this.targetInputGain - this.smoothedInputGain) * 0.15;
    const preLimiterGain = this.normalizerGain * this.smoothedInputGain;
    const projectedPeak = blockPeak * preLimiterGain;
    const peakCeiling = 0.85;
    const desiredLimiter = projectedPeak > peakCeiling && projectedPeak > 1e-5
      ? peakCeiling / projectedPeak
      : 1.0;

    const targetGate = !this.muted && this.gateOpen ? 1 : 0;
    let env = this.gateEnvelope;
    let lim = this.limiterGain;
    const coeff = targetGate > env ? this.attackCoeff : this.releaseCoeff;
    const limCoeff = desiredLimiter < lim ? 0.45 : 0.008;
    for (let i = 0; i < len; i += 1) {
      env += (targetGate - env) * coeff;
      lim += (desiredLimiter - lim) * limCoeff;
      const sample = Math.max(-0.96, Math.min(0.96, outChannel0[i] * env * preLimiterGain * lim));
      outChannel0[i] = sample;
    }
    this.gateEnvelope = env;
    this.limiterGain = lim;

    // Duplicate mono processed voice to remaining output channels if any.
    for (let c = 1; c < outputChannels.length; c += 1) {
      outputChannels[c].set(outChannel0);
    }

    // Meter aggregation (~20 Hz).
    this.meterPeakSq += sqSum;
    this.meterSamples += len;
    this.meterAccumulator += len;
    if (this.meterAccumulator >= this.meterIntervalSamples) {
      const avgRms = Math.sqrt(this.meterPeakSq / Math.max(1, this.meterSamples));
      const meterDb = Math.max(-100, Math.min(0, avgRms > 1e-6 ? 20 * Math.log10(avgRms) : -100));
      this.port.postMessage({
        levelDb: meterDb,
        gateOpen: !this.muted && this.gateOpen,
        thresholdDb: this.lastPublishedThresholdDb,
      });
      this.meterAccumulator = 0;
      this.meterPeakSq = 0;
      this.meterSamples = 0;
    }

    return true;
  }
}

registerProcessor('p2sharer-voice-processor', VoiceNoiseGateProcessor);

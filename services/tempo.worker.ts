/// <reference lib="webworker" />
/**
 * Tempo and downbeat detection by spectral flux onset analysis.
 *
 * Pipeline:
 *   decimate → STFT (Hann) → half-wave-rectified spectral flux → adaptive
 *   whitening → autocorrelation with a tempo prior → comb-filter refinement of
 *   period *and* phase over the whole track.
 *
 * The refinement stage is what makes the result usable as a click grid: a
 * period estimated only from autocorrelation is quantised to the hop size
 * (~2% error, which is ~3 seconds of drift across a song). Matching a comb
 * against the entire onset envelope pins the period down to ~0.03%.
 */

export interface TempoRequest {
  /** Mono mixdown of the material to analyse. */
  samples: Float32Array;
  sampleRate: number;
  /** Bar lengths to report a downbeat position for. */
  meters: number[];
}

export interface TempoResponse {
  bpm: number;
  firstBeatS: number;
  confidence: number;
  /** Best first-downbeat time (seconds) per requested bar length. */
  downbeats: { beatsPerBar: number; firstDownbeatS: number }[];
}

const MIN_BPM = 60;
const MAX_BPM = 200;
const TARGET_RATE = 11025;
const FFT_SIZE = 1024;
const HOP = 128;
/** Centre of the log-normal tempo prior used to resolve octave ambiguity. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_WIDTH = 0.9;

// ------------------------------------------------------------------ radix-2 FFT

function fftInPlace(re: Float32Array, im: Float32Array) {
  const n = re.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len >> 1; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + (len >> 1)] * curRe - im[i + k + (len >> 1)] * curIm;
        const vIm = re[i + k + (len >> 1)] * curIm + im[i + k + (len >> 1)] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + (len >> 1)] = uRe - vRe;
        im[i + k + (len >> 1)] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ----------------------------------------------------------------- preprocessing

/** Anti-aliased decimation to ~TARGET_RATE (box filter is adequate for onsets). */
function decimate(samples: Float32Array, sampleRate: number): { data: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  if (factor === 1) return { data: samples, rate: sampleRate };

  const outLen = Math.floor(samples.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) sum += samples[base + j];
    out[i] = sum / factor;
  }
  return { data: out, rate: sampleRate / factor };
}

interface Flux {
  full: Float32Array;
  low: Float32Array;
  frameRate: number;
}

function spectralFlux(data: Float32Array, rate: number): Flux {
  const frames = Math.max(0, Math.floor((data.length - FFT_SIZE) / HOP) + 1);
  const bins = FFT_SIZE >> 1;
  const full = new Float32Array(Math.max(frames, 1));
  const low = new Float32Array(Math.max(frames, 1));

  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }

  // Bins below ~200 Hz carry the kick, which is the best downbeat cue.
  const lowBinMax = Math.max(1, Math.round((200 / (rate / 2)) * bins));

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(bins);
  const prev = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = data[base + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);

    let sum = 0;
    let lowSum = 0;
    for (let b = 0; b < bins; b++) {
      // Log-compressed magnitude: keeps quiet onsets from being swamped.
      const m = Math.log1p(100 * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
      mag[b] = m;
      const d = m - prev[b];
      if (d > 0) {
        sum += d;
        if (b < lowBinMax) lowSum += d;
      }
    }
    full[f] = sum;
    low[f] = lowSum;
    prev.set(mag);
  }

  return { full, low, frameRate: rate / HOP };
}

/** Subtract a moving average and half-wave rectify — flattens dynamics. */
function whiten(x: Float32Array, windowFrames: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = Math.max(1, Math.floor(windowFrames / 2));

  // Running sum for an O(n) moving average.
  let sum = 0;
  for (let i = 0; i < Math.min(half, x.length); i++) sum += x[i];
  let lo = 0;
  let hi = Math.min(half, x.length);

  for (let i = 0; i < x.length; i++) {
    const newLo = Math.max(0, i - half);
    const newHi = Math.min(x.length, i + half);
    while (hi < newHi) sum += x[hi++];
    while (lo < newLo) sum -= x[lo++];
    const mean = sum / Math.max(1, hi - lo);
    const v = x[i] - mean;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

// --------------------------------------------------------------------- tempo

/** Trailing-RMS window for the sample-domain onset detector, in samples. */
const ONSET_RMS_W = 32;
/** Lag the RMS is differenced over, in samples. */
const ONSET_DIFF_D = 64;

/**
 * Sample-resolution onset strength.
 *
 * The STFT flux is excellent at finding the *period* but is systematically
 * early about *phase*: a Hann-windowed frame starts reacting to a transient
 * long before that transient reaches the middle of the window, which put the
 * detected downbeat ~70 ms ahead of the real one. This envelope is computed
 * straight from the waveform, so the phase it yields is unbiased.
 */
function sampleOnset(data: Float32Array): Float32Array {
  const n = data.length;
  const rms = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += data[i] * data[i];
    if (i >= ONSET_RMS_W) sum -= data[i - ONSET_RMS_W] * data[i - ONSET_RMS_W];
    rms[i] = Math.sqrt(sum / Math.min(i + 1, ONSET_RMS_W));
  }

  const out = new Float32Array(n);
  for (let i = ONSET_DIFF_D; i < n; i++) {
    const d = rms[i] - rms[i - ONSET_DIFF_D];
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

function linearAt(x: Float32Array, pos: number): number {
  if (pos < 0 || pos >= x.length - 1) return 0;
  const i = pos | 0;
  const frac = pos - i;
  return x[i] * (1 - frac) + x[i + 1] * frac;
}

/** Mean envelope value on a comb of period `period` starting at `phase`. */
function combScore(env: Float32Array, period: number, phase: number): number {
  let sum = 0;
  let n = 0;
  for (let pos = phase; pos < env.length - 1; pos += period) {
    sum += linearAt(env, pos);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function bestPhase(env: Float32Array, period: number, step: number): { phase: number; score: number } {
  let best = 0;
  let bestScore = -1;
  for (let p = 0; p < period; p += step) {
    const s = combScore(env, period, p);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return { phase: best, score: bestScore };
}

self.onmessage = (e: MessageEvent<TempoRequest>) => {
  const { samples, sampleRate, meters } = e.data;

  const { data, rate } = decimate(samples, sampleRate);
  const flux = spectralFlux(data, rate);
  const env = whiten(flux.full, Math.round(flux.frameRate * 0.4));
  const lowEnv = whiten(flux.low, Math.round(flux.frameRate * 0.4));

  const minLag = Math.max(2, Math.floor((60 / MAX_BPM) * flux.frameRate));
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / MIN_BPM) * flux.frameRate));

  // 1. Autocorrelation of the onset envelope, weighted by a tempo prior, to
  //    choose the right metrical level.
  let bestLag = minLag;
  let bestAc = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < env.length; i++) ac += env[i] * env[i + lag];
    ac /= Math.max(1, env.length - lag);

    const bpm = (60 * flux.frameRate) / lag;
    const logDev = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH;
    const prior = Math.exp(-0.5 * logDev * logDev);

    const score = ac * prior;
    if (score > bestAc) {
      bestAc = score;
      bestLag = lag;
    }
  }

  // 2. Refine period and phase against the whole envelope. Autocorrelation is
  //    quantised to the hop; this is not.
  let period = bestLag;
  let phase = 0;
  let score = 0;
  {
    const lo = bestLag * 0.96;
    const hi = bestLag * 1.04;
    const steps = 400;
    for (let s = 0; s <= steps; s++) {
      const p = lo + ((hi - lo) * s) / steps;
      const r = bestPhase(env, p, 1);
      if (r.score > score) {
        score = r.score;
        period = p;
        phase = r.phase;
      }
    }
    // Sub-frame phase polish (~1 ms resolution).
    const fine = bestPhase(env, period, 0.05);
    if (fine.score >= score) {
      phase = fine.phase;
      score = fine.score;
    }
  }

  let meanEnv = 0;
  for (let i = 0; i < env.length; i++) meanEnv += env[i];
  meanEnv /= Math.max(1, env.length);
  const confidence = meanEnv > 0 ? Math.max(0, Math.min(1, score / (meanEnv * 4))) : 0;

  const bpm = (60 * flux.frameRate) / period;

  // 3. Pin the phase down on the waveform itself. The period is already known,
  //    so this only has to slide one comb across a single beat's worth of
  //    positions — and it removes the STFT's window bias.
  const periodSamples = period * HOP;
  const onset = sampleOnset(data);
  const phaseStep = Math.max(1, Math.round(0.0005 * rate)); // ~0.5 ms
  let refinedPhase = phase * HOP;
  {
    let best = -1;
    for (let p = 0; p < periodSamples; p += phaseStep) {
      const s = combScore(onset, periodSamples, p);
      if (s > best) {
        best = s;
        refinedPhase = p;
      }
    }
  }
  // The trailing RMS window puts the envelope's peak about half a window late.
  const firstBeatSamples = Math.max(0, refinedPhase - ONSET_RMS_W / 2);
  const firstBeatS = firstBeatSamples / rate;

  // 4. Downbeats: among the beats of a bar, the one carrying the most
  //    low-frequency onset energy is the "1". A constant phase bias shifts
  //    every candidate equally, so this choice is safe to make in frame domain.
  const downbeats = meters.map((beatsPerBar) => {
    if (beatsPerBar <= 1) return { beatsPerBar, firstDownbeatS: firstBeatS };
    let bestIdx = 0;
    let bestVal = -1;
    for (let k = 0; k < beatsPerBar; k++) {
      const v = combScore(lowEnv, period * beatsPerBar, phase + k * period);
      if (v > bestVal) {
        bestVal = v;
        bestIdx = k;
      }
    }
    return { beatsPerBar, firstDownbeatS: (firstBeatSamples + bestIdx * periodSamples) / rate };
  });

  const res: TempoResponse = { bpm, firstBeatS, confidence, downbeats };
  (self as unknown as Worker).postMessage(res);
};

/**
 * Main-thread wrappers around the peaks and tempo workers.
 * Both keep a single long-lived worker and dispatch by request id.
 */
import type { PeakData, TempoAnalysis } from '../types';
import type { PeaksRequest, PeaksResponse } from './peaks.worker';
import type { TempoRequest, TempoResponse } from './tempo.worker';

/** Envelope resolution — plenty for any realistic waveform width. */
export const PEAK_BUCKETS = 4096;

/** Tempo detection only needs a representative slice; keeps analysis snappy. */
const TEMPO_ANALYSIS_MAX_S = 180;

let peaksWorker: Worker | null = null;
const peaksPending = new Map<string, (r: PeaksResponse) => void>();

function getPeaksWorker(): Worker {
  if (!peaksWorker) {
    peaksWorker = new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' });
    peaksWorker.onmessage = (e: MessageEvent<PeaksResponse>) => {
      const resolve = peaksPending.get(e.data.id);
      if (resolve) {
        peaksPending.delete(e.data.id);
        resolve(e.data);
      }
    };
  }
  return peaksWorker;
}

/**
 * Build a track's waveform envelope. Channel data is copied before transfer —
 * transferring `getChannelData()` directly would detach the AudioBuffer.
 */
export function computePeaks(id: string, buffer: AudioBuffer): Promise<PeakData> {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < Math.min(2, buffer.numberOfChannels); ch++) {
    channels.push(new Float32Array(buffer.getChannelData(ch)));
  }

  return new Promise<PeakData>((resolve) => {
    peaksPending.set(id, (r) => resolve({ min: r.min, max: r.max }));
    const req: PeaksRequest = { id, channels, buckets: PEAK_BUCKETS };
    getPeaksWorker().postMessage(
      req,
      channels.map((c) => c.buffer),
    );
  });
}

export interface TempoResult extends TempoAnalysis {
  downbeats: { beatsPerBar: number; firstDownbeatS: number }[];
}

/** Mono mixdown of the leading `TEMPO_ANALYSIS_MAX_S` of a buffer. */
function monoSlice(buffer: AudioBuffer): Float32Array {
  const length = Math.min(buffer.length, Math.round(TEMPO_ANALYSIS_MAX_S * buffer.sampleRate));
  const out = new Float32Array(length);
  const nch = buffer.numberOfChannels;
  for (let ch = 0; ch < nch; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / nch;
  }
  return out;
}

/**
 * Detect tempo and downbeat positions from one or more buffers.
 * Multiple buffers are summed first, so analysing a full stem set behaves like
 * analysing the mix rather than one arbitrary track.
 */
export function detectTempo(buffers: AudioBuffer[], meters: number[]): Promise<TempoResult> {
  if (buffers.length === 0) return Promise.reject(new Error('No audio to analyse'));

  const sampleRate = buffers[0].sampleRate;
  const slices = buffers.map(monoSlice);
  const length = Math.max(...slices.map((s) => s.length));
  const mixed = new Float32Array(length);
  for (const s of slices) {
    for (let i = 0; i < s.length; i++) mixed[i] += s[i];
  }
  // Normalise so confidence thresholds do not depend on stem count.
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(mixed[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    for (let i = 0; i < length; i++) mixed[i] /= peak;
  }

  return new Promise<TempoResult>((resolve, reject) => {
    const worker = new Worker(new URL('./tempo.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<TempoResponse>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || 'Tempo analysis failed'));
    };
    const req: TempoRequest = { samples: mixed, sampleRate, meters };
    worker.postMessage(req, [mixed.buffer]);
  });
}

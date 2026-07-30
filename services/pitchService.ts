/**
 * Offline pitch shifting with automatic latency compensation.
 *
 * Two things were wrong with doing this live, in the graph:
 *
 * 1. SoundTouch's WSOLA pipeline buffers audio, so the pitched bus came out
 *    tens of milliseconds *late* while the click track (routed around it)
 *    stayed on time. Transposing therefore pulled the click off the beat —
 *    exactly the reported symptom.
 * 2. The live node and the offline export path could disagree, so what you
 *    heard was not what you bounced.
 *
 * Rendering offline fixes both: `processOffline` returns a buffer of the same
 * length and sample rate as the input, and preview and export now share this
 * one code path. The remaining algorithmic delay is *measured* per pitch value
 * (by pushing a known impulse through the same settings) and trimmed off, so
 * shifted tracks stay frame-aligned with unshifted ones.
 */
import { processOffline } from '@soundtouchjs/audio-worklet';
import soundtouchProcessorUrl from '@soundtouchjs/audio-worklet/processor?url';

/** Position of the calibration burst inside the test signal, in seconds. */
const CAL_BURST_AT_S = 0.5;
const CAL_TOTAL_S = 1.5;
const CAL_BURST_LEN_S = 0.12;
const CAL_FREQ_HZ = 1000;

const latencyCache = new Map<string, Promise<number>>();
const renderCache = new Map<string, Promise<AudioBuffer>>();

/**
 * Measure SoundTouch's output delay for a given pitch shift, in samples.
 * Renders a silence → burst → silence signal and reports how far the burst
 * onset moved. Cached per (semitones, sampleRate).
 */
function measureLatencySamples(semitones: number, sampleRate: number): Promise<number> {
  const key = `${semitones}@${sampleRate}`;
  const cached = latencyCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    try {
      const length = Math.round(CAL_TOTAL_S * sampleRate);
      const burstStart = Math.round(CAL_BURST_AT_S * sampleRate);
      const burstLen = Math.round(CAL_BURST_LEN_S * sampleRate);

      const offline = new OfflineAudioContext(1, length, sampleRate);
      const input = offline.createBuffer(1, length, sampleRate);
      const data = input.getChannelData(0);
      for (let i = 0; i < burstLen; i++) {
        // Short attack/decay so the burst has an unambiguous onset.
        const env = Math.min(1, i / (0.002 * sampleRate)) * (1 - i / burstLen);
        data[burstStart + i] = env * Math.sin((2 * Math.PI * CAL_FREQ_HZ * i) / sampleRate);
      }

      const out = await processOffline({
        input,
        processorUrl: soundtouchProcessorUrl,
        pitchSemitones: semitones,
      });

      const o = out.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < o.length; i++) {
        const a = Math.abs(o[i]);
        if (a > peak) peak = a;
      }
      if (peak < 1e-4) return 0; // processing produced nothing usable

      const thresh = peak * 0.1;
      let onset = -1;
      for (let i = 0; i < o.length; i++) {
        if (Math.abs(o[i]) >= thresh) {
          onset = i;
          break;
        }
      }
      if (onset < 0) return 0;

      const delay = onset - burstStart;
      // Sanity clamp: a real delay is small and non-negative. Anything wild
      // means the measurement failed, and shifting by it would do more harm.
      if (delay < 0 || delay > sampleRate) return 0;
      return delay;
    } catch (err) {
      console.warn('Pitch latency calibration failed; continuing uncompensated', err);
      return 0;
    }
  })();

  latencyCache.set(key, task);
  return task;
}

/** Copy `src` into a fresh buffer, advanced by `shiftSamples` (drops the head). */
function compensate(src: AudioBuffer, shiftSamples: number): AudioBuffer {
  if (shiftSamples <= 0) return src;

  const out = new AudioBuffer({
    numberOfChannels: src.numberOfChannels,
    length: src.length,
    sampleRate: src.sampleRate,
  });
  const copyLen = Math.max(0, src.length - shiftSamples);
  if (copyLen > 0) {
    const scratch = new Float32Array(copyLen);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
      src.copyFromChannel(scratch, ch, shiftSamples);
      out.copyToChannel(scratch, ch, 0);
    }
  }
  return out;
}

/**
 * Pitch-shift a buffer while preserving its exact length and timing.
 * Results are cached per (cacheKey, semitones) so re-renders are instant.
 */
export async function renderPitched(
  buffer: AudioBuffer,
  semitones: number,
  cacheKey: string,
): Promise<AudioBuffer> {
  if (semitones === 0) return buffer;

  const key = `${cacheKey}:${semitones}`;
  const cached = renderCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const [shifted, latency] = await Promise.all([
      processOffline({
        input: buffer,
        processorUrl: soundtouchProcessorUrl,
        pitchSemitones: semitones,
      }),
      measureLatencySamples(semitones, buffer.sampleRate),
    ]);
    return compensate(shifted, latency);
  })();

  renderCache.set(key, task);
  // A failed render must not poison the cache forever.
  task.catch(() => renderCache.delete(key));
  return task;
}

/** Drop every cached render for a track (called when the track is removed). */
export function invalidatePitchCache(cacheKey: string): void {
  for (const key of [...renderCache.keys()]) {
    if (key.startsWith(`${cacheKey}:`)) renderCache.delete(key);
  }
}

export function clearPitchCache(): void {
  renderCache.clear();
}

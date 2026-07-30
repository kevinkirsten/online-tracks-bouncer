import type { ClickSignature } from '../types';

export type { ClickSignature };

interface ClickBaseDef {
  url: string;
  srcBpm: number;
  beatsPerBar: number;
  label: string;
}

// base + project URL is computed at runtime so it works in dev and built (gh-pages) paths
const baseUrl = (file: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/clicks/${file}`;

export const CLICK_BASES: Record<ClickSignature, ClickBaseDef> = {
  '1_4': { url: baseUrl('1_4_116.wav'), srcBpm: 116, beatsPerBar: 1, label: '1/4' },
  '3_4': { url: baseUrl('3_4_137.wav'), srcBpm: 137, beatsPerBar: 3, label: '3/4' },
  '4_4': { url: baseUrl('4_4_116.wav'), srcBpm: 116, beatsPerBar: 4, label: '4/4' },
  // 6/8: pulse is the eighth note — srcBpm here is the pulse (eighth) BPM
  '6_8': { url: baseUrl('6_8_137.wav'), srcBpm: 137, beatsPerBar: 6, label: '6/8' },
};

/** Cached per (url, sampleRate) — decoding resamples to the context rate. */
const baseBufferCache = new Map<string, Promise<AudioBuffer>>();
/** Per-beat clips extracted from a base file, cached alongside it. */
const clipCache = new Map<string, Float32Array[]>();

async function loadBaseBuffer(url: string, audioCtx: BaseAudioContext): Promise<AudioBuffer> {
  const key = `${url}@${audioCtx.sampleRate}`;
  const cached = baseBufferCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch click sample: ${url} (${res.status})`);
    return audioCtx.decodeAudioData(await res.arrayBuffer());
  })();

  baseBufferCache.set(key, task);
  task.catch(() => baseBufferCache.delete(key));
  return task;
}

/** Drop leading near-silence so every clip starts exactly on its transient. */
function trimOnset(seg: Float32Array, thresh = 0.005): Float32Array {
  let onset = 0;
  while (onset < seg.length && Math.abs(seg[onset]) <= thresh) onset++;
  return seg.subarray(onset);
}

/**
 * Split the base bar into one clip per beat, preserving the source's own accent
 * pattern (so 6/8 keeps its secondary accent on beat 4, etc.).
 */
async function getClips(def: ClickBaseDef, audioCtx: BaseAudioContext): Promise<Float32Array[]> {
  const key = `${def.url}@${audioCtx.sampleRate}`;
  const cached = clipCache.get(key);
  if (cached) return cached;

  const base = await loadBaseBuffer(def.url, audioCtx);
  const data = base.getChannelData(0);
  const srcBeatSamples = Math.round((60 / def.srcBpm) * base.sampleRate);

  const clips: Float32Array[] = [];
  for (let i = 0; i < def.beatsPerBar; i++) {
    const start = i * srcBeatSamples;
    if (start >= data.length) break;
    const end = Math.min(start + srcBeatSamples, data.length);
    clips.push(trimOnset(data.subarray(start, end)));
  }
  if (clips.length === 0) throw new Error(`Click sample for ${def.label} is empty`);

  clipCache.set(key, clips);
  return clips;
}

export interface GenerateClickOpts {
  signature: ClickSignature;
  bpm: number;
  durationS: number;
  /** Positive = delay the first downbeat; negative = pull it earlier. Seconds. */
  offsetS?: number;
  audioContext: BaseAudioContext;
}

/**
 * Render a mono click track locked to a constant grid.
 *
 * Beat positions are derived from the exact float period, so there is no
 * cumulative rounding drift. Each clip is truncated to the destination beat
 * length with a short fade, which keeps fast tempos crisp instead of piling
 * overlapping tails on top of each other.
 */
export async function generateClickBuffer(opts: GenerateClickOpts): Promise<AudioBuffer> {
  const def = CLICK_BASES[opts.signature];
  if (!def) throw new Error(`Unknown signature: ${opts.signature}`);
  if (!(opts.bpm > 0)) throw new Error('BPM must be greater than 0');
  if (!(opts.durationS > 0)) throw new Error('Duration must be greater than 0');

  const clips = await getClips(def, opts.audioContext);
  const sampleRate = opts.audioContext.sampleRate;

  const totalSamples = Math.round(opts.durationS * sampleRate);
  const out = new Float32Array(totalSamples);
  const beatSamples = (60 / opts.bpm) * sampleRate; // float — no drift
  const offsetSamples = (opts.offsetS ?? 0) * sampleRate;

  // Never let one click run into the next.
  const maxClipLen = Math.max(1, Math.floor(beatSamples));
  const fadeLen = Math.min(Math.round(0.004 * sampleRate), maxClipLen >> 2);

  // The grid is anchored at `offsetSamples`; beats before 0 are skipped but
  // still counted, so a negative offset does not rotate the accent pattern.
  const firstBeat = Math.floor(-offsetSamples / beatSamples);

  for (let b = firstBeat; ; b++) {
    const pos = Math.round(b * beatSamples + offsetSamples);
    if (pos >= totalSamples) break;

    const clip = clips[((b % clips.length) + clips.length) % clips.length];
    const clipLen = Math.min(clip.length, maxClipLen);
    if (pos + clipLen <= 0) continue;

    const dstStart = Math.max(0, pos);
    const clipStart = dstStart - pos;
    const n = Math.min(clipLen - clipStart, totalSamples - dstStart);
    if (n <= 0) continue;

    for (let i = 0; i < n; i++) {
      const idx = clipStart + i;
      // Fade the tail only when the clip was actually cut short.
      let gain = 1;
      if (clipLen < clip.length && idx > clipLen - fadeLen) {
        gain = (clipLen - idx) / fadeLen;
      }
      out[dstStart + i] += clip[idx] * gain;
    }
  }

  // Defensive normalisation — overlapping accents can only ever sum upward.
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.999) {
    const g = 0.999 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
  }

  const result = opts.audioContext.createBuffer(1, totalSamples, sampleRate);
  result.copyToChannel(out, 0);
  return result;
}

export function clickTrackName(signature: ClickSignature, bpm: number): string {
  return `Click ${CLICK_BASES[signature].label} ${Math.round(bpm * 100) / 100}bpm`;
}

/// <reference lib="webworker" />
/**
 * Computes waveform min/max envelopes off the main thread.
 *
 * Peaks are built once per track at a fixed high resolution and then
 * downsampled at draw time, so resizing the window or re-rendering costs
 * nothing. This is what replaced WaveSurfer's per-track <audio> element.
 */

export interface PeaksRequest {
  id: string;
  /** One Float32Array per channel (transferred, so they must be copies). */
  channels: Float32Array[];
  buckets: number;
}

export interface PeaksResponse {
  id: string;
  min: Float32Array;
  max: Float32Array;
}

self.onmessage = (e: MessageEvent<PeaksRequest>) => {
  const { id, channels, buckets } = e.data;
  const length = channels[0]?.length ?? 0;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);

  if (length > 0) {
    const perBucket = length / buckets;
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * perBucket);
      const end = Math.min(length, Math.max(start + 1, Math.floor((b + 1) * perBucket)));
      let lo = 0;
      let hi = 0;
      for (let ch = 0; ch < channels.length; ch++) {
        const data = channels[ch];
        for (let i = start; i < end; i++) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[b] = lo;
      max[b] = hi;
    }
  }

  const res: PeaksResponse = { id, min, max };
  (self as unknown as Worker).postMessage(res, [min.buffer, max.buffer]);
};

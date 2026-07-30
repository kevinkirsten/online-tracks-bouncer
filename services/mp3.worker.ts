/// <reference lib="webworker" />
/**
 * MP3 encoding off the main thread.
 *
 * This used to be a Blob worker built from a source string that pulled lamejs
 * off a CDN with `importScripts`, which meant exporting MP3 silently required
 * network access and an uncontrolled third-party version. It is now a real
 * module worker with the encoder bundled in.
 */
import { Mp3Encoder } from '@breezystack/lamejs';

export interface Mp3Request {
  channels: number;
  sampleRate: number;
  /** Transferred — must be copies, not live AudioBuffer channel data. */
  samplesL: Float32Array;
  samplesR: Float32Array;
  kbps: number;
}

export interface Mp3Response {
  blob?: Blob;
  error?: string;
}

/** Float [-1,1] → signed 16-bit, clamped. */
function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = Math.max(-1, Math.min(1, input[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

self.onmessage = (e: MessageEvent<Mp3Request>) => {
  const { channels, sampleRate, samplesL, samplesR, kbps } = e.data;
  const post = (msg: Mp3Response) => (self as unknown as Worker).postMessage(msg);

  try {
    const isStereo = channels > 1;
    const encoder = new Mp3Encoder(isStereo ? 2 : 1, sampleRate, kbps);
    const blockSize = 1152; // one MP3 frame
    const chunks: Uint8Array[] = [];

    const left = toInt16(samplesL);
    const right = isStereo ? toInt16(samplesR) : null;

    for (let i = 0; i < left.length; i += blockSize) {
      const chunkL = left.subarray(i, i + blockSize);
      // A mono encoder must be fed a single channel — passing a second one
      // produces garbage.
      const buf = right ? encoder.encodeBuffer(chunkL, right.subarray(i, i + blockSize)) : encoder.encodeBuffer(chunkL);
      if (buf.length > 0) chunks.push(buf);
    }

    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(tail);

    post({ blob: new Blob(chunks as BlobPart[], { type: 'audio/mpeg' }) });
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};

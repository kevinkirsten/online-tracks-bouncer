import { AudioTrack } from '../types';
import { renderPitched } from './pitchService';
import type { Mp3Request, Mp3Response } from './mp3.worker';

/** Constant bitrate used for MP3 exports, in kbps. */
const MP3_BITRATE = 320;

// Helper to convert an AudioBuffer to a WAV Blob
export function audioBufferToWav(buffer: AudioBuffer, opt?: any): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = opt?.float32 ? 3 : 1;
  const bitDepth = format === 3 ? 32 : 16;

  let result: Float32Array;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }

  return encodeWAV(result, format, sampleRate, numChannels, bitDepth);
}

/** Encode an AudioBuffer to MP3 in a worker, so the UI stays responsive. */
async function audioBufferToMp3(buffer: AudioBuffer): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });

    // Copy before transferring — handing over the channel data directly would
    // detach the AudioBuffer's own storage.
    const channels = buffer.numberOfChannels;
    const samplesL = new Float32Array(buffer.getChannelData(0));
    const samplesR = channels > 1 ? new Float32Array(buffer.getChannelData(1)) : new Float32Array(0);

    worker.onmessage = (e: MessageEvent<Mp3Response>) => {
      worker.terminate();
      if (e.data.error) reject(new Error(e.data.error));
      else if (e.data.blob) resolve(e.data.blob);
      else reject(new Error('MP3 encoder returned no data'));
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`MP3 worker error: ${e.message}`));
    };

    const req: Mp3Request = {
      channels,
      sampleRate: buffer.sampleRate,
      samplesL,
      samplesR,
      kbps: MP3_BITRATE,
    };
    worker.postMessage(req, [samplesL.buffer, samplesR.buffer]);
  });
}

function interleave(inputL: Float32Array, inputR: Float32Array) {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);

  let index = 0;
  let inputIndex = 0;

  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function encodeWAV(samples: Float32Array, format: number, sampleRate: number, numChannels: number, bitDepth: number) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* RIFF chunk length */
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * bytesPerSample, true);

  if (format === 1) {
    // 16-bit PCM
    floatTo16BitPCM(view, 44, samples);
  } else {
    // 32-bit Float
    writeFloat32(view, 44, samples);
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function writeFloat32(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
}

export const estimateFileSize = (duration: number, format: 'wav' | 'mp3', sampleRate = 44100): string => {
  if (duration <= 0) return '0 MB';

  let bytes = 0;
  if (format === 'wav') {
    // sampleRate * 16-bit (2 bytes) * 2 channels + header
    bytes = sampleRate * 2 * 2 * duration + 44;
  } else {
    // MP3 320 kbps → 40,000 bytes per second
    bytes = 40000 * duration;
  }

  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};

export interface BounceResult {
  blob: Blob;
  /** Peak sample of the mix. Above 1.0 means the export clipped. */
  peak: number;
}

/**
 * Render the session to a single file.
 *
 * Pitch shifting goes through the same `renderPitched` cache the preview uses,
 * so a bounce sounds exactly like what was playing (and is nearly free when the
 * shift was already auditioned).
 */
export const bounceTracks = async (
  tracks: AudioTrack[],
  masterVolume: number = 1.0,
  format: 'wav' | 'mp3' = 'wav',
  pitchSemitones: number = 0,
): Promise<BounceResult> => {
  const activeTracks = tracks.filter((t) => !t.isMuted && t.status === 'ready' && t.audioBuffer);

  if (activeTracks.length === 0) {
    throw new Error('Nothing to export — every track is muted or still loading.');
  }

  // 1. Resolve the buffer each track actually contributes.
  const parts: { buffer: AudioBuffer; volume: number }[] = [];
  let maxDuration = 0;

  for (const track of activeTracks) {
    // Click tracks are never pitch-shifted — that is the point of the flag.
    const buffer =
      pitchSemitones !== 0 && !track.isClick
        ? await renderPitched(track.audioBuffer!, pitchSemitones, track.id)
        : track.audioBuffer!;

    if (buffer.duration > maxDuration) maxDuration = buffer.duration;
    parts.push({ buffer, volume: track.volume });
  }

  // 2. Mix offline at the source sample rate (no needless resampling).
  const sampleRate = parts[0].buffer.sampleRate;
  const length = Math.ceil(maxDuration * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

  const masterGainNode = offlineCtx.createGain();
  masterGainNode.gain.value = masterVolume;
  masterGainNode.connect(offlineCtx.destination);

  for (const { buffer, volume } of parts) {
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    const trackGain = offlineCtx.createGain();
    trackGain.gain.value = volume;

    source.connect(trackGain);
    trackGain.connect(masterGainNode);
    source.start(0);
  }

  const renderedBuffer = await offlineCtx.startRendering();

  // 3. Report clipping so the UI can warn instead of silently distorting.
  let peak = 0;
  for (let ch = 0; ch < renderedBuffer.numberOfChannels; ch++) {
    const data = renderedBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
  }

  const blob = format === 'mp3' ? await audioBufferToMp3(renderedBuffer) : audioBufferToWav(renderedBuffer);
  return { blob, peak };
};
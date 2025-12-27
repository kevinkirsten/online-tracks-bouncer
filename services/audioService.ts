import { AudioTrack } from '../types';

// lamejs is loaded via <script> tag in index.html for the main thread, 
// but for the worker we need to import it explicitly inside the worker scope.
declare const lamejs: any;

// --- WORKER CODE AS STRING ---
// We use a Blob Worker to avoid needing a separate file/bundler configuration.
// This worker runs the encoding in a separate thread at full CPU speed.
const WORKER_CODE = `
importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');

self.onmessage = function(e) {
  const { channels, sampleRate, samplesL, samplesR } = e.data;
  
  if (typeof lamejs === 'undefined') {
    self.postMessage({ error: 'Failed to load lamejs in worker' });
    return;
  }

  try {
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 320);
    const mp3Data = [];
    const sampleBlockSize = 1152;
    
    // Convert Float32 to Int16
    // We do this inside the worker to keep the main thread completely free
    const length = samplesL.length;
    const samplesL_int16 = new Int16Array(length);
    const samplesR_int16 = new Int16Array(length);

    for (let i = 0; i < length; i++) {
      // Left
      let valL = Math.max(-1, Math.min(1, samplesL[i]));
      samplesL_int16[i] = valL < 0 ? valL * 0x8000 : valL * 0x7FFF;
      
      // Right
      let valR = samplesR ? Math.max(-1, Math.min(1, samplesR[i])) : valL;
      samplesR_int16[i] = valR < 0 ? valR * 0x8000 : valR * 0x7FFF;
    }

    // Encode Loop (Tight loop, no timeouts needed here!)
    for (let i = 0; i < length; i += sampleBlockSize) {
      const chunkL = samplesL_int16.subarray(i, i + sampleBlockSize);
      const chunkR = samplesR_int16.subarray(i, i + sampleBlockSize);
      const mp3buf = mp3encoder.encodeBuffer(chunkL, chunkR);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }
    }

    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    // Send back the Blob
    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    self.postMessage({ blob });
    
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
`;

// Helper to convert an AudioBuffer to a WAV Blob
function audioBufferToWav(buffer: AudioBuffer, opt?: any): Blob {
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

// Optimized Helper to convert AudioBuffer to MP3 Blob using a Web Worker
async function audioBufferToMp3(buffer: AudioBuffer): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Create Worker from string
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);

    // Prepare data
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const samplesL = buffer.getChannelData(0);
    const samplesR = channels > 1 ? buffer.getChannelData(1) : new Float32Array(samplesL);

    worker.onmessage = (e) => {
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else if (e.data.blob) {
        resolve(e.data.blob);
      }
      worker.terminate(); // Cleanup
      URL.revokeObjectURL(workerUrl); // Cleanup URL
    };

    worker.onerror = (e) => {
      reject(new Error("Worker error: " + e.message));
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };

    // Send data to worker
    // We use the second argument [transferList] to transfer ownership of the buffers
    // This makes sending the data instantaneous (zero-copy)
    worker.postMessage({
      channels,
      sampleRate,
      samplesL, // These will be transferred
      samplesR  // These will be transferred
    }, [samplesL.buffer, samplesR.buffer]); // Transfer buffer ownership
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

export const loadAudioBuffer = async (blob: Blob, audioContext: AudioContext): Promise<AudioBuffer> => {
  const arrayBuffer = await blob.arrayBuffer();
  return await audioContext.decodeAudioData(arrayBuffer);
};

export const estimateFileSize = (duration: number, format: 'wav' | 'mp3'): string => {
  if (duration <= 0) return '0 MB';

  let bytes = 0;
  if (format === 'wav') {
    // 44.1kHz * 16-bit (2 bytes) * 2 channels
    bytes = 44100 * 2 * 2 * duration; 
    // Add header size (minimal)
    bytes += 44;
  } else {
    // MP3 320kbps
    // 320,000 bits / 8 = 40,000 bytes per second
    bytes = 40000 * duration;
  }

  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};

export const bounceTracks = async (tracks: AudioTrack[], masterVolume: number = 1.0, format: 'wav' | 'mp3' = 'wav'): Promise<Blob> => {
  // 1. Determine max duration
  let maxDuration = 0;
  const activeTracks = tracks.filter(t => !t.isMuted);

  if (activeTracks.length === 0) {
    throw new Error("No tracks to export (or all are muted).");
  }

  // We need the audio buffers to know the duration
  const tempCtx = new AudioContext();
  const buffers: { buffer: AudioBuffer; volume: number }[] = [];

  for (const track of activeTracks) {
    let buffer = track.audioBuffer;
    if (!buffer) {
       buffer = await loadAudioBuffer(track.file, tempCtx);
    }
    
    if (buffer) {
      if (buffer.duration > maxDuration) maxDuration = buffer.duration;
      buffers.push({ buffer, volume: track.volume });
    }
  }

  tempCtx.close();

  // 2. Create Offline Context
  const sampleRate = 44100; 
  const length = Math.ceil(maxDuration * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

  // Create Master Gain
  const masterGainNode = offlineCtx.createGain();
  masterGainNode.gain.value = masterVolume;
  masterGainNode.connect(offlineCtx.destination);

  // 3. Schedule Sources
  buffers.forEach(({ buffer, volume }) => {
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    
    const trackGain = offlineCtx.createGain();
    trackGain.gain.value = volume;

    source.connect(trackGain);
    trackGain.connect(masterGainNode);
    
    source.start(0);
  });

  // 4. Render
  const renderedBuffer = await offlineCtx.startRendering();

  // 5. Convert to format
  if (format === 'mp3') {
    return await audioBufferToMp3(renderedBuffer);
  } else {
    return audioBufferToWav(renderedBuffer);
  }
};
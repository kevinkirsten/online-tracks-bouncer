import WaveSurfer from 'wavesurfer.js';

export interface AudioTrack {
  id: string;
  name: string;
  file: File;
  url: string; // Blob URL
  volume: number; // 0.0 to 1.0
  isMuted: boolean;
  isSolo: boolean;
  duration: number;
  wavesurfer?: WaveSurfer;
  audioBuffer?: AudioBuffer; // Cached for export
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isExporting: boolean;
}

export type TrackStatus = 'loading' | 'ready' | 'error';
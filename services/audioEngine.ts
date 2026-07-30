/**
 * Sample-accurate multitrack transport.
 *
 * Every track plays from an AudioBufferSourceNode scheduled against one shared
 * anchor (`startCtxTime` / `startOffset`). Because all sources are started with
 * the same absolute `when`, they are locked together by the audio clock and can
 * never drift — regardless of how many play/pause/seek cycles happen.
 *
 * The previous implementation drove one HTMLAudioElement per track (via
 * WaveSurfer) and tried to repair the resulting drift by periodically seeking
 * followers to a "leader". That is what made the playheads scatter and the
 * click lose the beat. There is no drift correction here because there is no
 * drift to correct.
 */

/** Sources are scheduled this far ahead so they all begin on the same frame. */
const START_LOOKAHEAD_S = 0.06;
/** Ramp time for gain changes — long enough to avoid zipper noise. */
const GAIN_RAMP_S = 0.015;

interface EngineTrack {
  id: string;
  buffer: AudioBuffer | null;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  volume: number;
  muted: boolean;
}

export interface TransportState {
  time: number;
  isPlaying: boolean;
  duration: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly analyserL: AnalyserNode;
  readonly analyserR: AnalyserNode;

  private tracks = new Map<string, EngineTrack>();
  private playing = false;
  /** ctx.currentTime at which the current playback run starts. */
  private startCtxTime = 0;
  /** Timeline position corresponding to `startCtxTime`. */
  private startOffset = 0;
  /** Playhead position while paused. */
  private pausedAt = 0;

  private subs = new Set<(s: TransportState) => void>();
  private rafId = 0;

  constructor() {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    // `interactive` keeps output latency as low as the device allows.
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    const splitter = this.ctx.createChannelSplitter(2);
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;
    this.analyserL.smoothingTimeConstant = 0.2;
    this.analyserR.smoothingTimeConstant = 0.2;

    this.master.connect(splitter);
    splitter.connect(this.analyserL, 0);
    splitter.connect(this.analyserR, 1);
    this.master.connect(this.ctx.destination);
  }

  // ---------------------------------------------------------------- transport

  get isPlaying() {
    return this.playing;
  }

  /** Longest track currently loaded, in seconds. */
  get duration() {
    let max = 0;
    for (const t of this.tracks.values()) {
      if (t.buffer && t.buffer.duration > max) max = t.buffer.duration;
    }
    return max;
  }

  /** Current playhead position in seconds, derived from the audio clock. */
  getCurrentTime(): number {
    if (!this.playing) return this.pausedAt;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    // Before the scheduled start instant, the playhead has not moved yet.
    if (elapsed <= 0) return this.startOffset;
    return Math.min(this.startOffset + elapsed, this.duration);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    await this.resume();

    const duration = this.duration;
    if (duration <= 0) return;

    // Starting at (or past) the end rewinds, matching every DAW's behaviour.
    let offset = this.pausedAt;
    if (offset >= duration - 1e-4) offset = 0;

    this.startOffset = offset;
    this.startCtxTime = this.ctx.currentTime + START_LOOKAHEAD_S;
    this.playing = true;

    for (const t of this.tracks.values()) this.startSource(t);
    this.startLoop();
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.getCurrentTime();
    this.playing = false;
    for (const t of this.tracks.values()) this.stopSource(t);
    this.notify();
  }

  stop(): void {
    this.playing = false;
    this.pausedAt = 0;
    for (const t of this.tracks.values()) this.stopSource(t);
    this.notify();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  /** Move the playhead. Keeps playing (in sync) if it was already playing. */
  seek(time: number): void {
    const clamped = Math.max(0, Math.min(time, this.duration));
    if (!this.playing) {
      this.pausedAt = clamped;
      this.notify();
      return;
    }
    // Re-anchor and relaunch every source against the new position, all at the
    // same instant, so they stay sample-locked.
    this.startOffset = clamped;
    this.startCtxTime = this.ctx.currentTime + START_LOOKAHEAD_S;
    for (const t of this.tracks.values()) {
      this.stopSource(t);
      this.startSource(t);
    }
    this.notify();
  }

  /** Move the playhead by a relative amount. */
  nudge(deltaS: number): void {
    this.seek(this.getCurrentTime() + deltaS);
  }

  // --------------------------------------------------------------- observers

  /**
   * Subscribe to transport updates: once per animation frame while playing,
   * plus one update on every transport change. Consumers that only need the
   * playhead can use this to move DOM/canvas directly instead of re-rendering.
   */
  subscribe(cb: (s: TransportState) => void): () => void {
    this.subs.add(cb);
    cb(this.snapshot());
    return () => {
      this.subs.delete(cb);
    };
  }

  private snapshot(): TransportState {
    return { time: this.getCurrentTime(), isPlaying: this.playing, duration: this.duration };
  }

  private notify() {
    const s = this.snapshot();
    for (const cb of this.subs) cb(s);
  }

  private startLoop() {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop = () => {
    if (!this.playing) return;
    const duration = this.duration;
    if (duration > 0 && this.getCurrentTime() >= duration - 1e-4) {
      // Reached the end: park the playhead there, like a DAW does.
      this.playing = false;
      for (const t of this.tracks.values()) this.stopSource(t);
      this.pausedAt = duration;
      this.notify();
      return;
    }
    this.notify();
    this.rafId = requestAnimationFrame(this.loop);
  };

  /** Resume the context — must be called from a user gesture at least once. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* browser will retry on the next gesture */
      }
    }
  }

  // ------------------------------------------------------------------- tracks

  /**
   * Add a track or replace its buffer. When called during playback the source
   * is relaunched at the exact current position, so swapping a buffer (pitch
   * render, click offset change) never knocks the track out of sync.
   */
  setTrackBuffer(id: string, buffer: AudioBuffer | null): void {
    let t = this.tracks.get(id);
    if (!t) {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      t = { id, buffer: null, gain, source: null, volume: 1, muted: false };
      this.tracks.set(id, t);
    }
    if (t.buffer === buffer) return;
    t.buffer = buffer;
    if (this.playing) {
      this.stopSource(t);
      this.startSource(t);
    }
    this.notify(); // duration may have changed
  }

  setTrackGain(id: string, volume: number, muted: boolean): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.volume = volume;
    t.muted = muted;
    const target = muted ? 0 : volume;
    t.gain.gain.setTargetAtTime(target, this.ctx.currentTime, GAIN_RAMP_S);
  }

  setMasterGain(volume: number): void {
    this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, GAIN_RAMP_S);
  }

  removeTrack(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.stopSource(t);
    t.gain.disconnect();
    this.tracks.delete(id);
    // Removing the longest track shortens the timeline; keep the playhead legal.
    this.pausedAt = Math.min(this.pausedAt, this.duration);
    if (this.tracks.size === 0) this.playing = false;
    this.notify();
  }

  removeAllTracks(): void {
    for (const id of [...this.tracks.keys()]) {
      const t = this.tracks.get(id)!;
      this.stopSource(t);
      t.gain.disconnect();
      this.tracks.delete(id);
    }
    this.playing = false;
    this.pausedAt = 0;
    this.notify();
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  createBuffer(channels: number, length: number, sampleRate?: number): AudioBuffer {
    return this.ctx.createBuffer(channels, length, sampleRate ?? this.ctx.sampleRate);
  }

  close(): void {
    cancelAnimationFrame(this.rafId);
    this.subs.clear();
    this.removeAllTracks();
    void this.ctx.close();
  }

  // ------------------------------------------------------------------ private

  private startSource(t: EngineTrack) {
    if (!t.buffer || !this.playing) return;

    // Where inside this specific buffer playback should begin. Tracks shorter
    // than the timeline simply have nothing left to play — they stay silent
    // instead of being seeked to a wrong position, which is the bug that made
    // short tracks (and the click) jump around after a seek.
    const offsetInTrack = this.startOffset;
    if (offsetInTrack >= t.buffer.duration) return;

    const src = this.ctx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.gain);
    src.start(this.startCtxTime, Math.max(0, offsetInTrack));
    t.source = src;
  }

  private stopSource(t: EngineTrack) {
    if (!t.source) return;
    try {
      t.source.onended = null;
      t.source.stop();
    } catch {
      /* already stopped */
    }
    t.source.disconnect();
    t.source = null;
  }
}

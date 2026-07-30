import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Upload, Play, Pause, Download, Music, Square, Trash2, Plus, ChevronDown,
  FileAudio, CircleHelp, Drum, SkipBack, Loader2, AlertTriangle, ZoomIn, ZoomOut, Maximize2,
} from 'lucide-react';
import { AudioTrack } from './types';
import { TrackRow, DEFAULT_TRACK_VOLUME } from './components/TrackRow';
import { MasterMeter } from './components/MasterMeter';
import { GlobalTimeline } from './components/GlobalTimeline';
import { bounceTracks, estimateFileSize } from './services/audioService';
import { HelpModal } from './components/HelpModal';
import { ClickTrackModal } from './components/ClickTrackModal';
import { Transposer, Note } from './components/Transposer';
import { GitHubCorner, CORNER_SIZE } from './components/GitHubCorner';
import { generateClickBuffer, clickTrackName, ClickSignature, CLICK_BASES } from './services/clickService';
import { AudioEngine } from './services/audioEngine';
import { renderPitched, invalidatePitchCache, clearPitchCache } from './services/pitchService';
import { computePeaks, detectTempo, TempoResult } from './services/analysisService';

/** A track contributes to the mix unless something else is soloed. */
const isAudible = (track: AudioTrack, anySolo: boolean) => (anySolo ? !!track.isSolo : !track.isMuted);

/** Shortest window the timeline can zoom to, in seconds. */
const MIN_VIEW_S = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Visible span of the timeline. `duration: 0` means "fit the whole session",
 * which keeps the view correct as tracks are added or removed.
 */
interface View {
  start: number;
  duration: number;
}

const formatTime = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const App: React.FC = () => {
  // One engine for the whole session. Created lazily so the AudioContext is
  // only ever constructed once, even under StrictMode's double render.
  const engineRef = useRef<AudioEngine>();
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1.0);

  // Global transposer
  const [pitchSemitones, setPitchSemitones] = useState(0);
  const [referenceKey, setReferenceKey] = useState<Note | null>(null);
  const [isRenderingPitch, setIsRenderingPitch] = useState(false);

  // UI state
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isClickModalOpen, setIsClickModalOpen] = useState(false);
  const [isBounceMenuOpen, setIsBounceMenuOpen] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'warn' | 'error'; text: string } | null>(null);
  const bounceMenuRef = useRef<HTMLDivElement>(null);

  const anySolo = useMemo(() => tracks.some((t) => t.isSolo), [tracks]);
  const readyTracks = useMemo(() => tracks.filter((t) => t.status === 'ready'), [tracks]);

  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  // ---------------------------------------------------------- timeline view

  const [view, setView] = useState<View>({ start: 0, duration: 0 });
  const durationRef = useRef(0);
  durationRef.current = duration;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Resolved window, always legal for the current session length.
  const viewDuration = view.duration > 0 ? Math.min(view.duration, duration || 1) : duration || 1;
  const viewStart = view.duration > 0 ? clamp(view.start, 0, Math.max(0, duration - viewDuration)) : 0;
  const isZoomed = view.duration > 0 && duration > 0 && viewDuration < duration - 1e-6;

  const zoomAt = useCallback((factor: number, anchorS: number) => {
    setView((prev) => {
      const total = durationRef.current;
      if (total <= 0) return prev;
      const curDur = prev.duration > 0 ? Math.min(prev.duration, total) : total;
      const curStart = prev.duration > 0 ? prev.start : 0;
      const nextDur = clamp(curDur * factor, MIN_VIEW_S, total);
      if (nextDur >= total) return { start: 0, duration: 0 }; // back to fit
      // Keep whatever is under the cursor pinned to the same screen position.
      const frac = curDur > 0 ? (anchorS - curStart) / curDur : 0.5;
      return { start: clamp(anchorS - frac * nextDur, 0, total - nextDur), duration: nextDur };
    });
  }, []);

  const panBy = useCallback((deltaS: number) => {
    setView((prev) => {
      const total = durationRef.current;
      if (prev.duration <= 0 || total <= 0) return prev;
      const dur = Math.min(prev.duration, total);
      return { start: clamp(prev.start + deltaS, 0, total - dur), duration: dur };
    });
  }, []);

  const fitView = useCallback(() => setView({ start: 0, duration: 0 }), []);

  /** Zoom by a fixed step, anchored on the playhead when it is on screen. */
  const zoomStep = useCallback(
    (factor: number) => {
      const v = viewRef.current;
      const total = durationRef.current;
      const dur = v.duration > 0 ? Math.min(v.duration, total) : total;
      const start = v.duration > 0 ? v.start : 0;
      const playhead = engine.getCurrentTime();
      const anchor = playhead >= start && playhead <= start + dur ? playhead : start + dur / 2;
      zoomAt(factor, anchor);
    },
    [engine, zoomAt],
  );

  /**
   * Identity of the set of tracks that the pitch shifter applies to. Used as an
   * effect dependency so re-rendering pitch is triggered by tracks appearing or
   * changing role — not by every volume nudge.
   */
  const pitchTargetKey = useMemo(
    () =>
      tracks
        .filter((t) => t.status === 'ready' && !t.isClick)
        .map((t) => t.id)
        .join(','),
    [tracks],
  );

  // ------------------------------------------------------------- transport

  // Mirror the engine into React state. Time is throttled to 10 Hz because the
  // only thing that needs it at that rate is the clock — the playheads are
  // painted straight from the engine at full frame rate.
  useEffect(() => {
    let lastPublished = -1;
    return engine.subscribe((s) => {
      setIsPlaying(s.isPlaying);
      setDuration(s.duration);
      const tick = Math.floor(s.time * 10);
      if (tick !== lastPublished) {
        lastPublished = tick;
        setCurrentTime(s.time);
      }

      // While zoomed in, page the window along so the playhead stays visible.
      const v = viewRef.current;
      if (s.isPlaying && v.duration > 0 && (s.time < v.start || s.time > v.start + v.duration)) {
        const total = durationRef.current;
        setView((prev) => ({
          ...prev,
          start: clamp(s.time - prev.duration * 0.1, 0, Math.max(0, total - prev.duration)),
        }));
      }
    });
  }, [engine]);

  // Note: the engine is deliberately never closed on unmount. This component
  // lives for the lifetime of the page, and StrictMode's simulated unmount
  // would otherwise tear down the AudioContext for good.

  useEffect(() => {
    engine.setMasterGain(masterVolume);
  }, [engine, masterVolume]);

  // Push every gain change to the engine (solo wins over mute, like a DAW).
  useEffect(() => {
    for (const track of tracks) {
      engine.setTrackGain(track.id, track.volume, !isAudible(track, anySolo));
    }
  }, [engine, tracks, anySolo]);

  const togglePlay = useCallback(() => {
    void engine.toggle();
  }, [engine]);

  const handleStop = useCallback(() => {
    engine.stop();
  }, [engine]);

  const handleSeek = useCallback(
    (time: number) => {
      engine.seek(time);
      // Seeking outside the zoomed window brings the window along, which makes
      // the overview strip at the bottom double as a navigator.
      setView((prev) => {
        if (prev.duration <= 0) return prev;
        if (time >= prev.start && time <= prev.start + prev.duration) return prev;
        const total = durationRef.current;
        return {
          ...prev,
          start: clamp(time - prev.duration / 2, 0, Math.max(0, total - prev.duration)),
        };
      });
    },
    [engine],
  );

  // ------------------------------------------------------------ track loading

  /** Resolve the buffer a track should play, applying the global pitch shift. */
  const resolvePlaybackBuffer = useCallback(
    async (track: AudioTrack, semitones: number): Promise<AudioBuffer | null> => {
      if (!track.audioBuffer) return null;
      if (semitones === 0 || track.isClick) return track.audioBuffer;
      return renderPitched(track.audioBuffer, semitones, track.id);
    },
    [],
  );

  const pitchSemitonesRef = useRef(pitchSemitones);
  useEffect(() => {
    pitchSemitonesRef.current = pitchSemitones;
  }, [pitchSemitones]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      void engine.resume();

      const incoming = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|flac|opus)$/i.test(f.name));
      if (incoming.length === 0) return;

      const pending: AudioTrack[] = incoming.map((file) => ({
        id: uuidv4(),
        name: file.name.replace(/\.[^/.]+$/, ''),
        file,
        volume: DEFAULT_TRACK_VOLUME,
        isMuted: false,
        isSolo: false,
        duration: 0,
        status: 'loading',
      }));

      setTracks((prev) => [...prev, ...pending]);

      // Decode and analyse each file independently so one bad file cannot
      // block the rest, and so the first track is playable immediately.
      for (const track of pending) {
        void (async () => {
          try {
            const buffer = await engine.decode(await track.file!.arrayBuffer());
            const peaks = await computePeaks(track.id, buffer);

            setTracks((prev) =>
              prev.map((t) =>
                t.id === track.id
                  ? { ...t, audioBuffer: buffer, peaks, duration: buffer.duration, status: 'ready' as const }
                  : t,
              ),
            );

            const playable = await resolvePlaybackBuffer(
              { ...track, audioBuffer: buffer },
              pitchSemitonesRef.current,
            );
            engine.setTrackBuffer(track.id, playable);
          } catch (err) {
            console.error('Failed to load track', track.name, err);
            setTracks((prev) =>
              prev.map((t) =>
                t.id === track.id
                  ? { ...t, status: 'error' as const, error: 'Unsupported or corrupted audio file' }
                  : t,
              ),
            );
          }
        })();
      }
    },
    [engine, resolvePlaybackBuffer],
  );

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = ''; // allow re-picking the same file
  };

  // ------------------------------------------------------------------- pitch

  // Re-render every pitched track when the transposer moves. Renders are cached
  // per (track, semitone), so going back to a previous value is instant.
  const pitchRunRef = useRef(0);
  useEffect(() => {
    const run = ++pitchRunRef.current;
    const targets = tracksRef.current.filter((t) => t.status === 'ready' && !t.isClick && t.audioBuffer);
    if (targets.length === 0) return;

    if (pitchSemitones === 0) {
      for (const t of targets) engine.setTrackBuffer(t.id, t.audioBuffer!);
      setIsRenderingPitch(false);
      return;
    }

    setIsRenderingPitch(true);
    void (async () => {
      try {
        const rendered = await Promise.all(
          targets.map(async (t) => [t.id, await renderPitched(t.audioBuffer!, pitchSemitones, t.id)] as const),
        );
        if (run !== pitchRunRef.current) return; // superseded by a newer value
        for (const [id, buffer] of rendered) engine.setTrackBuffer(id, buffer);
      } catch (err) {
        console.error('Pitch shift failed', err);
        setNotice({ kind: 'error', text: 'Pitch shifting failed — playing at the original pitch.' });
      } finally {
        if (run === pitchRunRef.current) setIsRenderingPitch(false);
      }
    })();
  }, [engine, pitchSemitones, pitchTargetKey]);

  // ------------------------------------------------------------------- click

  const handleGenerateClick = useCallback(
    async (opts: { signature: ClickSignature; bpm: number; offsetMs: number }) => {
      await engine.resume();
      const durationS = engine.duration;
      if (!(durationS > 0)) {
        throw new Error('Load at least one track first so the click knows how long to be.');
      }

      const id = uuidv4();
      const buffer = await generateClickBuffer({
        signature: opts.signature,
        bpm: opts.bpm,
        durationS,
        offsetS: opts.offsetMs / 1000,
        audioContext: engine.ctx,
      });
      const peaks = await computePeaks(id, buffer);

      setTracks((prev) => [
        ...prev,
        {
          id,
          name: clickTrackName(opts.signature, opts.bpm),
          volume: DEFAULT_TRACK_VOLUME,
          isMuted: false,
          isSolo: false,
          duration: buffer.duration,
          audioBuffer: buffer,
          peaks,
          status: 'ready',
          isClick: true,
          clickMeta: { signature: opts.signature, bpm: opts.bpm, offsetMs: opts.offsetMs },
        },
      ]);
      engine.setTrackBuffer(id, buffer);
    },
    [engine],
  );

  /**
   * Re-render a click track in place. The buffer is swapped while the transport
   * keeps running, so nudging the offset no longer reloads audio or knocks the
   * click out of sync.
   */
  const regenerateClick = useCallback(
    async (track: AudioTrack, offsetMs: number, durationS: number) => {
      if (!track.clickMeta) return;
      try {
        const buffer = await generateClickBuffer({
          signature: track.clickMeta.signature,
          bpm: track.clickMeta.bpm,
          durationS,
          offsetS: offsetMs / 1000,
          audioContext: engine.ctx,
        });
        const peaks = await computePeaks(track.id, buffer);
        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? {
                  ...t,
                  audioBuffer: buffer,
                  peaks,
                  duration: buffer.duration,
                  clickMeta: { ...t.clickMeta!, offsetMs },
                }
              : t,
          ),
        );
        engine.setTrackBuffer(track.id, buffer);
      } catch (err) {
        console.error('Failed to regenerate the click', err);
      }
    },
    [engine],
  );

  const handleClickOffsetChange = useCallback(
    (track: AudioTrack, newOffsetMs: number) => {
      void regenerateClick(track, newOffsetMs, track.duration || engine.duration);
    },
    [engine, regenerateClick],
  );

  /** Dragging a click track's waveform slides its grid by that many seconds. */
  const handleClickDrag = useCallback(
    (track: AudioTrack, deltaS: number) => {
      if (!track.clickMeta || deltaS === 0) return;
      const next = Math.round(track.clickMeta.offsetMs + deltaS * 1000);
      void regenerateClick(track, next, track.duration || engine.duration);
    },
    [engine, regenerateClick],
  );

  // Adding a longer stem after the click was generated used to leave the click
  // ending early. Stretch it to cover the session instead.
  useEffect(() => {
    if (duration <= 0) return;
    for (const track of tracksRef.current) {
      if (track.clickMeta && track.status === 'ready' && track.duration < duration - 0.01) {
        void regenerateClick(track, track.clickMeta.offsetMs, duration);
      }
    }
  }, [duration, regenerateClick]);

  const handleDetectTempo = useCallback((): Promise<TempoResult> => {
    const sources = readyTracks.filter((t) => !t.isClick && t.audioBuffer).map((t) => t.audioBuffer!);
    if (sources.length === 0) return Promise.reject(new Error('Load a musical track first.'));
    const meters = Object.values(CLICK_BASES).map((d) => d.beatsPerBar);
    return detectTempo(sources, meters);
  }, [readyTracks]);

  // ---------------------------------------------------------------- mixing

  const handleVolumeChange = useCallback((id: string, volume: number) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, volume } : t)));
  }, []);

  const handleMuteToggle = useCallback((id: string) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, isMuted: !t.isMuted } : t)));
  }, []);

  // Solo is now purely additive: it no longer overwrites everyone's mute state,
  // so un-soloing restores exactly the mix you had before.
  const handleSoloToggle = useCallback((id: string) => {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, isSolo: !t.isSolo } : t)));
  }, []);

  const handleRemoveTrack = useCallback(
    (id: string) => {
      engine.removeTrack(id);
      invalidatePitchCache(id);
      setTracks((prev) => prev.filter((t) => t.id !== id));
    },
    [engine],
  );

  const handleClickToggle = useCallback(
    (id: string) => {
      const current = tracksRef.current.find((t) => t.id === id);
      if (!current) return;
      const next = { ...current, isClick: !current.isClick };
      setTracks((prev) => prev.map((t) => (t.id === id ? next : t)));

      // Toggling the flag moves the track in or out of the pitched set.
      if (next.audioBuffer) {
        void resolvePlaybackBuffer(next, pitchSemitonesRef.current).then((buf) => {
          if (buf) engine.setTrackBuffer(id, buf);
        });
      }
    },
    [engine, resolvePlaybackBuffer],
  );

  const moveTrack = useCallback((index: number, direction: 'up' | 'down') => {
    setTracks((items) => {
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= items.length) return items;
      const next = [...items];
      [next[index], next[newIndex]] = [next[newIndex], next[index]];
      return next;
    });
  }, []);

  const handleClearAll = useCallback(() => {
    engine.removeAllTracks();
    clearPitchCache();
    setTracks([]);
    setPitchSemitones(0);
    setReferenceKey(null);
    setNotice(null);
  }, [engine]);

  // ---------------------------------------------------------------- export

  const handleExport = async (format: 'wav' | 'mp3') => {
    setIsBounceMenuOpen(false);
    const audible = tracks.filter((t) => t.status === 'ready' && isAudible(t, anySolo));
    if (audible.length === 0) {
      setNotice({ kind: 'error', text: 'Nothing to bounce — no audible track.' });
      return;
    }

    setIsExporting(true);
    setNotice(null);
    try {
      const { blob, peak } = await bounceTracks(audible, masterVolume, format, pitchSemitones);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mix_bounce.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (peak > 1.0) {
        setNotice({
          kind: 'warn',
          text: `Heads up: the mix peaked at +${(20 * Math.log10(peak)).toFixed(1)} dB and clipped. Lower the master fader and bounce again for a clean file.`,
        });
      }
    } catch (err) {
      console.error('Export failed', err);
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Export failed. See the console for details.' });
    } finally {
      setIsExporting(false);
    }
  };

  // ------------------------------------------------------------- interaction

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bounceMenuRef.current && !bounceMenuRef.current.contains(event.target as Node)) {
        setIsBounceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard transport. Refs keep the listener stable so it is registered once.
  const shortcutsRef = useRef({ togglePlay, handleStop, engine, zoomStep, fitView, blocked: false });
  shortcutsRef.current = {
    togglePlay,
    handleStop,
    engine,
    zoomStep,
    fitView,
    blocked: isHelpOpen || isClickModalOpen,
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const { togglePlay, handleStop, engine, zoomStep, fitView, blocked } = shortcutsRef.current;
      if (blocked || e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }

      // Zoom is matched on the produced character rather than the physical key,
      // so it works on any layout (ABNT, numpad, Shift+= for '+').
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomStep(0.5);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomStep(2);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        fitView();
        return;
      }

      switch (e.code) {
        case 'Space':
          // Buttons activate on space too — drop focus so it fires only once.
          if (target?.tagName === 'BUTTON') target.blur();
          e.preventDefault();
          togglePlay();
          break;
        case 'Home':
          e.preventDefault();
          engine.seek(0);
          break;
        case 'Enter':
          e.preventDefault();
          handleStop();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          engine.nudge(e.shiftKey ? -1 : -5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          engine.nudge(e.shiftKey ? 1 : 5);
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingFile) setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingFile(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  // ------------------------------------------------------------------ render

  const getFooterTime = () => {
    if (!showRemaining) return formatTime(currentTime);
    return `-${formatTime(Math.max(0, duration - currentTime))}`;
  };

  const sampleRate = engine.ctx.sampleRate;
  const estimateWav = estimateFileSize(duration, 'wav', sampleRate);
  const estimateMp3 = estimateFileSize(duration, 'mp3', sampleRate);

  return (
    <div
      className="h-screen flex flex-col bg-daw-bg text-daw-text font-sans overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
      <ClickTrackModal
        isOpen={isClickModalOpen}
        onClose={() => setIsClickModalOpen(false)}
        onGenerate={handleGenerateClick}
        onDetect={handleDetectTempo}
        canDetect={readyTracks.some((t) => !t.isClick)}
        defaultDurationS={duration}
      />

      {/* Header */}
      <header className="h-14 flex-shrink-0 border-b border-daw-border bg-daw-panel flex items-center justify-between px-4 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded flex items-center justify-center">
              <Music size={18} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight hidden sm:block">
              Online<span className="text-daw-accent">Tracks</span>Bouncer
            </h1>
          </div>

          <button
            onClick={() => setIsHelpOpen(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-daw-muted hover:text-white hover:bg-daw-bg/50 transition-colors text-xs font-medium border border-transparent hover:border-daw-border"
            title="How to use"
          >
            <CircleHelp size={14} />
            <span className="hidden md:inline">How to use</span>
          </button>
        </div>

        <div className="flex items-center gap-4">
          <Transposer
            pitchSemitones={pitchSemitones}
            referenceKey={referenceKey}
            onPitchChange={setPitchSemitones}
            onReferenceKeyChange={setReferenceKey}
            isRendering={isRenderingPitch}
          />

          <div className="flex items-center bg-daw-bg rounded-lg p-1 border border-daw-border">
            <button
              onClick={() => handleSeek(0)}
              className="p-1.5 hover:text-daw-accent transition-colors"
              title="Back to start (Home)"
            >
              <SkipBack size={16} fill="currentColor" />
            </button>
            <button onClick={handleStop} className="p-1.5 hover:text-red-400 transition-colors" title="Stop (Enter)">
              <Square size={16} fill="currentColor" />
            </button>
            <div className="w-[1px] h-5 bg-daw-border mx-1" />
            <button
              onClick={togglePlay}
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              className={`p-1.5 rounded-md transition-all ${isPlaying ? 'bg-daw-accent text-white' : 'hover:text-daw-accent'}`}
            >
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
            </button>
          </div>

          <div className="font-mono text-lg text-daw-accent w-24 text-center bg-daw-bg py-0.5 px-2 rounded border border-daw-border">
            {formatTime(currentTime)}
          </div>

          <div className="relative" ref={bounceMenuRef}>
            <button
              onClick={() => !isExporting && tracks.length > 0 && setIsBounceMenuOpen(!isBounceMenuOpen)}
              disabled={tracks.length === 0 || isExporting}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                isExporting ? 'bg-yellow-600 cursor-wait' : 'bg-indigo-600 hover:bg-indigo-500'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {isExporting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Processing…
                </>
              ) : (
                <>
                  <Download size={16} />
                  Bounce
                  <ChevronDown size={14} className={`transition-transform duration-200 ${isBounceMenuOpen ? 'rotate-180' : ''}`} />
                </>
              )}
            </button>

            {isBounceMenuOpen && !isExporting && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-daw-panel border border-daw-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="p-2 border-b border-daw-border bg-daw-bg/50">
                  <span className="text-[10px] uppercase font-bold text-daw-muted tracking-wider">Select format</span>
                </div>
                <div className="p-1">
                  <button
                    onClick={() => handleExport('wav')}
                    className="w-full flex items-center justify-between p-3 hover:bg-daw-bg rounded-md group transition-colors text-left gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 p-2 bg-blue-500/10 text-blue-400 rounded group-hover:bg-blue-500 group-hover:text-white transition-colors">
                        <FileAudio size={20} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-bold text-sm truncate">WAV (PCM)</span>
                        <span className="text-[10px] text-daw-muted whitespace-nowrap">
                          Lossless • {(sampleRate / 1000).toFixed(1)}kHz • 16-bit
                        </span>
                      </div>
                    </div>
                    <span className="text-xs font-mono text-daw-accent bg-daw-bg px-2 py-1 rounded border border-daw-border group-hover:border-daw-accent/50 whitespace-nowrap flex-shrink-0">
                      ~{estimateWav}
                    </span>
                  </button>

                  <button
                    onClick={() => handleExport('mp3')}
                    className="w-full flex items-center justify-between p-3 hover:bg-daw-bg rounded-md group transition-colors text-left gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 p-2 bg-green-500/10 text-green-400 rounded group-hover:bg-green-500 group-hover:text-white transition-colors">
                        <FileAudio size={20} />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-bold text-sm truncate">MP3</span>
                        <span className="text-[10px] text-daw-muted whitespace-nowrap">Compressed • 320kbps</span>
                      </div>
                    </div>
                    <span className="text-xs font-mono text-daw-accent bg-daw-bg px-2 py-1 rounded border border-daw-border group-hover:border-daw-accent/50 whitespace-nowrap flex-shrink-0">
                      ~{estimateMp3}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {notice && (
        <div
          className={`flex-shrink-0 flex items-start gap-2 px-4 py-2 text-xs border-b ${
            notice.kind === 'error'
              ? 'bg-red-500/10 border-red-500/30 text-red-300'
              : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-200'
          }`}
        >
          <AlertTriangle size={14} className="mt-px flex-shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="opacity-60 hover:opacity-100 px-1">
            ✕
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 overflow-y-auto p-4 relative flex flex-col">
          {tracks.length === 0 ? (
            <div
              className={`flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-xl m-4 transition-all duration-300 ease-out ${
                isDraggingFile
                  ? 'border-daw-accent bg-daw-accent/10 scale-[1.02] shadow-[0_0_30px_rgba(99,102,241,0.2)]'
                  : 'border-daw-border text-daw-muted hover:border-daw-accent/50'
              }`}
            >
              <Upload
                size={48}
                className={`mb-4 transition-all duration-300 ${isDraggingFile ? 'text-daw-accent scale-110' : 'text-daw-accent opacity-50'}`}
              />
              <h2 className={`text-xl font-bold mb-2 transition-colors ${isDraggingFile ? 'text-daw-accent' : 'text-white'}`}>
                {isDraggingFile ? "Drop it like it's hot!" : 'Drop tracks here'}
              </h2>
              <label className="cursor-pointer bg-daw-panel border border-daw-border px-6 py-2 rounded-lg hover:bg-daw-border transition-colors">
                <span className="font-medium text-sm">Browse</span>
                <input type="file" multiple accept="audio/*" onChange={handleFileUpload} className="hidden" />
              </label>
              <div className="mt-4 text-xs text-daw-muted">Supports WAV, MP3, AAC, OGG, FLAC</div>
              <button
                onClick={() => setIsHelpOpen(true)}
                className="mt-6 flex items-center gap-1 text-daw-accent hover:text-white transition-colors text-sm"
              >
                <CircleHelp size={16} /> Need help getting started?
              </button>
            </div>
          ) : (
            <div className={`max-w-7xl mx-auto w-full pb-20 transition-all duration-300 ${isDraggingFile ? 'opacity-50 blur-sm scale-[0.99]' : ''}`}>
              <div className="flex items-center justify-between mb-2 px-1">
                <h3 className="text-xs uppercase tracking-wider text-daw-muted font-bold">Tracks ({tracks.length})</h3>
                <button
                  onClick={handleClearAll}
                  className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                  title="Clears everything: tracks, pitch and key"
                >
                  <Trash2 size={12} /> Clear all
                </button>
              </div>

              <div className="space-y-1">
                {tracks.map((track, index) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    engine={engine}
                    viewStart={viewStart}
                    viewDuration={viewDuration}
                    onZoom={zoomAt}
                    onPan={panBy}
                    onClickDrag={handleClickDrag}
                    onVolumeChange={handleVolumeChange}
                    onMuteToggle={handleMuteToggle}
                    onSoloToggle={handleSoloToggle}
                    onRemove={handleRemoveTrack}
                    onClickToggle={handleClickToggle}
                    onClickOffsetChange={handleClickOffsetChange}
                    onSeek={handleSeek}
                    isFirst={index === 0}
                    isLast={index === tracks.length - 1}
                    onMoveUp={() => moveTrack(index, 'up')}
                    onMoveDown={() => moveTrack(index, 'down')}
                  />
                ))}
              </div>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="cursor-pointer border-2 border-dashed border-daw-border rounded-lg p-5 flex flex-col items-center justify-center hover:border-daw-accent/50 hover:bg-daw-panel/30 transition-all group">
                  <div className="p-2.5 bg-daw-panel rounded-full mb-2 group-hover:scale-110 transition-transform">
                    <Plus size={20} className="text-daw-muted group-hover:text-daw-accent" />
                  </div>
                  <span className="text-sm font-medium text-daw-muted group-hover:text-daw-text">Add more tracks</span>
                  <input type="file" multiple accept="audio/*" onChange={handleFileUpload} className="hidden" />
                </label>

                <button
                  type="button"
                  onClick={() => setIsClickModalOpen(true)}
                  className="border-2 border-dashed border-daw-border rounded-lg p-5 flex flex-col items-center justify-center hover:border-amber-500/50 hover:bg-amber-500/5 transition-all group"
                  title="Generate a click track — it can detect the tempo from your stems"
                >
                  <div className="p-2.5 bg-daw-panel rounded-full mb-2 group-hover:scale-110 transition-transform">
                    <Drum size={20} className="text-daw-muted group-hover:text-amber-400" />
                  </div>
                  <span className="text-sm font-medium text-daw-muted group-hover:text-daw-text">Add click track</span>
                </button>
              </div>
            </div>
          )}

          {tracks.length > 0 && isDraggingFile && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-daw-bg/80 backdrop-blur-sm border-4 border-daw-accent/50 pointer-events-none animate-in fade-in duration-200">
              <div className="flex flex-col items-center animate-bounce">
                <Upload size={80} className="text-daw-accent mb-6" />
                <h2 className="text-3xl font-bold text-white tracking-tight">Drop files to add</h2>
              </div>
            </div>
          )}
        </main>

        <aside className="bg-daw-bg border-l border-daw-border shadow-2xl z-20">
          <MasterMeter
            analyserL={engine.analyserL}
            analyserR={engine.analyserR}
            masterVolume={masterVolume}
            onMasterVolumeChange={setMasterVolume}
          />
        </aside>
      </div>

      {tracks.length > 0 && (
        <div className="flex-shrink-0 flex flex-col z-50">
          <GlobalTimeline
            tracks={tracks}
            duration={duration}
            engine={engine}
            onSeek={handleSeek}
            viewStart={viewStart}
            viewDuration={viewDuration}
          />

          {/* Left padding clears the GitHub corner so the timecode stays visible. */}
          <footer
            className="h-10 bg-daw-panel border-t border-daw-border pr-4 flex items-center gap-3"
            style={{ paddingLeft: CORNER_SIZE + 8 }}
          >
            <span
              onClick={() => setShowRemaining(!showRemaining)}
              className="text-xs font-mono text-daw-muted min-w-[50px] cursor-pointer hover:text-white select-none"
              title="Click to toggle time mode"
            >
              {getFooterTime()}
            </span>
            <input
              type="range"
              min="0"
              max={duration || 100}
              step="0.01"
              value={currentTime}
              onChange={(e) => handleSeek(parseFloat(e.target.value))}
              className="flex-1 h-1.5 bg-daw-bg rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-daw-accent [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-125 transition-all"
            />
            <span className="text-xs font-mono text-daw-muted">{formatTime(duration)}</span>

            <div className="flex items-center gap-1 border-l border-daw-border pl-3 ml-1">
              <button
                onClick={() => zoomStep(2)}
                disabled={!isZoomed}
                title="Zoom out (Ctrl/⌘ + scroll on a waveform)"
                className="p-1 rounded text-daw-muted hover:text-white hover:bg-daw-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ZoomOut size={14} />
              </button>
              <button
                onClick={() => zoomStep(0.5)}
                title="Zoom in (Ctrl/⌘ + scroll on a waveform)"
                className="p-1 rounded text-daw-muted hover:text-white hover:bg-daw-bg transition-colors"
              >
                <ZoomIn size={14} />
              </button>
              <button
                onClick={fitView}
                disabled={!isZoomed}
                title="Fit the whole session"
                className="p-1 rounded text-daw-muted hover:text-white hover:bg-daw-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Maximize2 size={13} />
              </button>
              <span
                className={`text-[10px] font-mono w-16 text-right ${isZoomed ? 'text-daw-accent' : 'text-daw-muted/60'}`}
                title="Visible span"
              >
                {viewDuration < 1 ? `${Math.round(viewDuration * 1000)} ms` : `${viewDuration.toFixed(1)} s`}
              </span>
            </div>
          </footer>
        </div>
      )}

      <GitHubCorner href="https://github.com/kevinkirsten/online-tracks-bouncer" />
    </div>
  );
};

export default App;

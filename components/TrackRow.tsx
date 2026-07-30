import React, { useEffect, useState, memo } from 'react';
import { Clock, ChevronUp, ChevronDown, Drum, Minus, Plus, RotateCcw, AlertTriangle } from 'lucide-react';
import { AudioTrack } from '../types';
import { Waveform } from './Waveform';
import type { AudioEngine } from '../services/audioEngine';

export const DEFAULT_TRACK_VOLUME = 0.8;

interface TrackRowProps {
  track: AudioTrack;
  engine: AudioEngine;
  timelineDuration: number;
  onVolumeChange: (id: string, volume: number) => void;
  onMuteToggle: (id: string) => void;
  onSoloToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onClickToggle: (id: string) => void;
  onClickOffsetChange: (track: AudioTrack, newOffsetMs: number) => void;
  onSeek: (time: number) => void;

  // Reorder props
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

const formatDuration = (seconds: number) => {
  if (!seconds) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const getDbValue = (vol: number) => {
  if (vol <= 0.0001) return '-inf';
  return (20 * Math.log10(vol)).toFixed(1);
};

export const TrackRow = memo<TrackRowProps>(({
  track,
  engine,
  timelineDuration,
  onVolumeChange,
  onMuteToggle,
  onSoloToggle,
  onRemove,
  onClickToggle,
  onClickOffsetChange,
  onSeek,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}) => {
  const [dbInput, setDbInput] = useState<string>(() => getDbValue(DEFAULT_TRACK_VOLUME));
  const [isEditingDb, setIsEditingDb] = useState(false);
  const [offsetInput, setOffsetInput] = useState<string>('0');
  const [isEditingOffset, setIsEditingOffset] = useState(false);

  const isLoaded = track.status === 'ready';
  const offsetMs = track.clickMeta?.offsetMs ?? 0;

  // Keep the dB readout in sync when volume changes from elsewhere.
  useEffect(() => {
    if (!isEditingDb) setDbInput(getDbValue(track.isMuted ? 0 : track.volume));
  }, [track.volume, track.isMuted, isEditingDb]);

  useEffect(() => {
    if (!isEditingOffset) setOffsetInput(String(Math.round(offsetMs)));
  }, [offsetMs, isEditingOffset]);

  const commitDbChange = () => {
    setIsEditingDb(false);
    const valStr = dbInput.trim().toLowerCase();
    if (valStr === '-inf') {
      onVolumeChange(track.id, 0);
      return;
    }
    const parsedDb = parseFloat(valStr);
    if (isNaN(parsedDb)) {
      setDbInput(getDbValue(track.isMuted ? 0 : track.volume));
      return;
    }
    const clampedDb = Math.min(parsedDb, 0);
    onVolumeChange(track.id, Math.max(0, Math.min(1, Math.pow(10, clampedDb / 20))));
  };

  const commitOffsetChange = () => {
    setIsEditingOffset(false);
    const parsed = parseFloat(offsetInput.trim());
    if (isNaN(parsed)) {
      setOffsetInput(String(Math.round(offsetMs)));
      return;
    }
    onClickOffsetChange(track, Math.round(parsed));
  };

  return (
    <div
      className={`flex bg-daw-panel border rounded-lg mb-2 overflow-hidden hover:border-daw-accent/50 transition-colors h-28 shadow-sm ${
        track.status === 'error'
          ? 'border-red-500/50'
          : track.isClick
            ? 'border-amber-500/40'
            : 'border-daw-border'
      }`}
    >
      {/* Reorder column */}
      <div className="w-6 flex-shrink-0 flex flex-col items-center justify-center gap-2 py-2 bg-daw-bg/50 border-r border-daw-border text-daw-muted">
        <button
          className={`p-1 hover:text-white transition-colors hover:bg-daw-panel rounded ${isFirst ? 'opacity-20 cursor-default' : ''}`}
          onClick={onMoveUp}
          disabled={isFirst}
          title="Move up"
        >
          <ChevronUp size={16} />
        </button>
        <button
          className={`p-1 hover:text-white transition-colors hover:bg-daw-panel rounded ${isLast ? 'opacity-20 cursor-default' : ''}`}
          onClick={onMoveDown}
          disabled={isLast}
          title="Move down"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      {/* Controls column */}
      <div className="w-60 flex-shrink-0 flex flex-col justify-between p-3 border-r border-daw-border bg-daw-bg/30">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col overflow-hidden min-w-0">
            <span className="font-bold text-sm text-daw-text truncate" title={track.name}>
              {track.name}
            </span>
            <div className="flex items-center gap-2 text-[10px] text-daw-muted uppercase tracking-wider font-mono">
              {track.status === 'error' ? (
                <span className="flex items-center gap-1 text-red-400" title={track.error}>
                  <AlertTriangle size={10} /> Failed
                </span>
              ) : (
                <span className={isLoaded ? 'text-green-500/80' : 'animate-pulse text-yellow-500'}>
                  {isLoaded ? 'Ready' : 'Loading…'}
                </span>
              )}
              {track.duration > 0 && (
                <span className="flex items-center gap-0.5 text-daw-text/60">
                  <Clock size={10} /> {formatDuration(track.duration)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => onRemove(track.id)}
            className="text-daw-muted hover:text-red-400 p-1 transition-colors flex-shrink-0"
            title="Remove track"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 my-1">
          <button
            onClick={() => onMuteToggle(track.id)}
            title="Mute"
            className={`flex-1 py-1 rounded text-xs font-bold border transition-colors ${
              track.isMuted
                ? 'bg-red-500/20 border-red-500/50 text-red-400'
                : 'bg-daw-panel border-daw-border text-daw-muted hover:text-white'
            }`}
          >
            M
          </button>
          <button
            onClick={() => onSoloToggle(track.id)}
            title="Solo"
            className={`flex-1 py-1 rounded text-xs font-bold border transition-colors ${
              track.isSolo
                ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400'
                : 'bg-daw-panel border-daw-border text-daw-muted hover:text-white'
            }`}
          >
            S
          </button>
          <button
            onClick={() => onClickToggle(track.id)}
            title={
              track.isClick
                ? 'Click track — never pitch-shifted. Click to unmark.'
                : 'Mark as click track (skips the global pitch shift)'
            }
            className={`flex-1 py-1 rounded text-xs font-bold border flex items-center justify-center gap-1 transition-colors ${
              track.isClick
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                : 'bg-daw-panel border-daw-border text-daw-muted hover:text-white'
            }`}
          >
            <Drum size={11} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={track.volume}
            onChange={(e) => onVolumeChange(track.id, parseFloat(e.target.value))}
            onDoubleClick={() => onVolumeChange(track.id, DEFAULT_TRACK_VOLUME)}
            title="Double-click to reset to the default level"
            className="flex-1 h-1.5 bg-daw-border rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-daw-accent [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-white"
          />
          <div className="flex items-center justify-end w-14 gap-0.5 bg-daw-bg/50 rounded px-1 border border-transparent focus-within:border-daw-accent/50 transition-colors">
            <input
              type="text"
              value={dbInput}
              onFocus={() => setIsEditingDb(true)}
              onBlur={commitDbChange}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onChange={(e) => setDbInput(e.target.value)}
              className="w-full min-w-0 bg-transparent text-right text-[10px] font-mono text-daw-muted focus:text-daw-text outline-none p-0"
              spellCheck={false}
            />
            <span className="text-[10px] font-mono text-daw-muted select-none">dB</span>
          </div>
        </div>
      </div>

      {/* Waveform */}
      <div className="flex-1 relative bg-daw-bg min-w-0">
        {!isLoaded && track.status !== 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-daw-muted animate-pulse z-10">
            Decoding audio…
          </div>
        )}
        {track.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 z-10 px-4 text-center">
            {track.error ?? 'Could not decode this file'}
          </div>
        )}

        <div className="absolute inset-0 flex items-center">
          <Waveform
            peaks={track.peaks}
            duration={track.duration}
            timelineDuration={timelineDuration}
            engine={engine}
            color={track.isClick ? '#b45309' : '#646cff'}
            progressColor={track.isClick ? '#fbbf24' : '#a6acff'}
            height={80}
            onSeek={onSeek}
          />
        </div>

        {/* Offset nudge for generated click tracks */}
        {track.isClick && track.clickMeta && (
          <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-daw-panel/90 backdrop-blur-sm border border-amber-500/30 rounded px-1 py-0.5 shadow-lg z-20 text-[10px] font-mono">
            <span className="text-amber-400/80 px-1 select-none">{track.clickMeta.bpm} bpm · offset</span>
            <button
              onClick={() => onClickOffsetChange(track, offsetMs - 50)}
              className="p-0.5 hover:text-white text-daw-muted rounded hover:bg-daw-bg"
              title="−50 ms"
            >
              −50
            </button>
            <button
              onClick={() => onClickOffsetChange(track, offsetMs - 5)}
              className="p-0.5 hover:text-white text-daw-muted rounded hover:bg-daw-bg"
              title="−5 ms"
            >
              <Minus size={10} />
            </button>
            <input
              type="text"
              value={offsetInput}
              onFocus={() => setIsEditingOffset(true)}
              onBlur={commitOffsetChange}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onChange={(e) => setOffsetInput(e.target.value)}
              title="First-downbeat offset in milliseconds"
              className={`w-12 bg-transparent text-center outline-none focus:text-white ${
                offsetMs !== 0 ? 'text-amber-400 font-bold' : 'text-daw-text'
              }`}
              spellCheck={false}
            />
            <span className="text-daw-muted select-none pr-0.5">ms</span>
            <button
              onClick={() => onClickOffsetChange(track, offsetMs + 5)}
              className="p-0.5 hover:text-white text-daw-muted rounded hover:bg-daw-bg"
              title="+5 ms"
            >
              <Plus size={10} />
            </button>
            <button
              onClick={() => onClickOffsetChange(track, offsetMs + 50)}
              className="p-0.5 hover:text-white text-daw-muted rounded hover:bg-daw-bg"
              title="+50 ms"
            >
              +50
            </button>
            {offsetMs !== 0 && (
              <button
                onClick={() => onClickOffsetChange(track, 0)}
                className="p-0.5 hover:text-white text-daw-muted rounded hover:bg-daw-bg"
                title="Reset offset"
              >
                <RotateCcw size={10} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

TrackRow.displayName = 'TrackRow';

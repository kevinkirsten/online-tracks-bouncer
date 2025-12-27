import React, { useEffect, useRef, useState, memo } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Clock, ChevronUp, ChevronDown } from 'lucide-react';
import { AudioTrack } from '../types';

interface TrackRowProps {
  track: AudioTrack;
  isPlaying: boolean;
  audioContext: AudioContext | null;
  masterNode: AudioNode | null;
  onVolumeChange: (id: string, volume: number) => void;
  onMuteToggle: (id: string) => void;
  onSoloToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onReady: (id: string, ws: WaveSurfer, buffer: AudioBuffer) => void;
  
  // Reorder props
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

// Wrap in memo to prevent re-rendering entire list when Master Volume changes
export const TrackRow = memo<TrackRowProps>(({
  track,
  isPlaying,
  audioContext,
  masterNode,
  onVolumeChange,
  onMuteToggle,
  onSoloToggle,
  onRemove,
  onReady,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown
}) => {
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  // State for editable dB input
  const [dbInput, setDbInput] = useState<string>("-inf");
  const [isEditingDb, setIsEditingDb] = useState(false);

  // Convert linear volume (0-1) to dB for display
  const getDbValue = (vol: number) => {
    if (vol <= 0.0001) return '-inf';
    const db = 20 * Math.log10(vol);
    return db.toFixed(1);
  };

  // Sync internal DB state when volume changes externally (slider/mute)
  useEffect(() => {
    if (!isEditingDb) {
      setDbInput(getDbValue(track.isMuted ? 0 : track.volume));
    }
  }, [track.volume, track.isMuted, isEditingDb]);

  // Handle manual DB input commit (Enter or Blur)
  const commitDbChange = () => {
    setIsEditingDb(false);
    let valStr = dbInput.trim().toLowerCase();
    let newVol = 0;

    if (valStr === '-inf') {
      newVol = 0;
    } else {
      const parsedDb = parseFloat(valStr);
      if (!isNaN(parsedDb)) {
        // Convert dB to Linear: Vol = 10 ^ (dB / 20)
        const clampedDb = Math.min(parsedDb, 0); 
        newVol = Math.pow(10, clampedDb / 20);
      } else {
        setDbInput(getDbValue(track.isMuted ? 0 : track.volume));
        return;
      }
    }
    
    newVol = Math.max(0, Math.min(1, newVol));
    onVolumeChange(track.id, newVol);
  };

  const handleDbKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  // Format duration helper
  const formatDuration = (seconds: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    if (!waveformContainerRef.current) return;

    // Initialize WaveSurfer
    const ws = WaveSurfer.create({
      container: waveformContainerRef.current,
      waveColor: '#646cff',
      progressColor: '#a6acff',
      cursorColor: '#ececf1',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 80,
      normalize: true,
      minPxPerSec: 50,
      fillParent: true,
      interact: false,
    });

    ws.load(track.url);

    ws.on('ready', () => {
      // 1. Hook up to Master Meter Audio Graph
      if (audioContext && masterNode) {
        const mediaElement = ws.getMediaElement();
        if (!sourceNodeRef.current) {
             try {
                const source = audioContext.createMediaElementSource(mediaElement);
                source.connect(masterNode);
                sourceNodeRef.current = source;
             } catch (e) {
                console.warn("Could not connect source", e);
             }
        }
      }

      // 2. Fetch buffer for export cache
      const fetchBuffer = async () => {
        const ctx = new AudioContext();
        const arrayBuffer = await track.file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        ctx.close();
        onReady(track.id, ws, audioBuffer);
        setIsLoaded(true);
      };
      fetchBuffer();
    });

    ws.setVolume(track.isMuted ? 0 : track.volume);

    wavesurferRef.current = ws;

    return () => {
      ws.destroy();
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch for play/pause
  useEffect(() => {
    if (!wavesurferRef.current || !isLoaded) return;
    
    if (isPlaying) {
      wavesurferRef.current.play();
    } else {
      wavesurferRef.current.pause();
    }
  }, [isPlaying, isLoaded]);

  // Watch for volume/mute changes
  useEffect(() => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.setVolume(track.isMuted ? 0 : track.volume);
  }, [track.volume, track.isMuted]);

  return (
    <div 
      className="flex bg-daw-panel border border-daw-border rounded-lg mb-2 overflow-hidden hover:border-daw-accent/50 transition-colors h-28 shadow-sm"
    >
      
      {/* Reorder / Drag Handle Column */}
      <div className="w-6 flex-shrink-0 flex flex-col items-center justify-center gap-2 py-2 bg-daw-bg/50 border-r border-daw-border text-daw-muted">
         <button 
            className={`p-1 hover:text-white transition-colors hover:bg-daw-panel rounded ${isFirst ? 'opacity-20 cursor-default' : ''}`}
            onClick={onMoveUp}
            disabled={isFirst}
            title="Move Up"
         >
            <ChevronUp size={16} />
         </button>
         
         <button 
            className={`p-1 hover:text-white transition-colors hover:bg-daw-panel rounded ${isLast ? 'opacity-20 cursor-default' : ''}`}
            onClick={onMoveDown}
            disabled={isLast}
            title="Move Down"
         >
            <ChevronDown size={16} />
         </button>
      </div>

      {/* LEFT: Controls Column (Fixed Width, no overlap) */}
      <div className="w-60 flex-shrink-0 flex flex-col justify-between p-3 border-r border-daw-border bg-daw-bg/30">
        
        {/* Top: Name & Remove */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col overflow-hidden min-w-0">
            <span className="font-bold text-sm text-daw-text truncate" title={track.name}>
              {track.name}
            </span>
            <div className="flex items-center gap-2 text-[10px] text-daw-muted uppercase tracking-wider font-mono">
                <span className={isLoaded ? 'text-green-500/80' : 'animate-pulse text-yellow-500'}>
                    {isLoaded ? 'Ready' : 'LOADING...'}
                </span>
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
            title="Remove Track"
          >
            ✕
          </button>
        </div>
        
        {/* Middle: Buttons */}
        <div className="flex items-center gap-2 my-1">
          <button
            onClick={() => onMuteToggle(track.id)}
            className={`flex-1 py-1 rounded text-xs font-bold border ${
              track.isMuted 
              ? 'bg-red-500/20 border-red-500/50 text-red-400' 
              : 'bg-daw-panel border-daw-border text-daw-muted hover:text-white'
            }`}
          >
            M
          </button>
          <button
            onClick={() => onSoloToggle(track.id)}
            className={`flex-1 py-1 rounded text-xs font-bold border ${
              track.isSolo 
              ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400' 
              : 'bg-daw-panel border-daw-border text-daw-muted hover:text-white'
            }`}
          >
            S
          </button>
        </div>

        {/* Bottom: Volume & dB */}
        <div className="flex items-center gap-2">
            <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={track.volume}
                onChange={(e) => onVolumeChange(track.id, parseFloat(e.target.value))}
                onPointerDown={(e) => e.stopPropagation()} // Prevent drag when using slider
                className="flex-1 h-1.5 bg-daw-border rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-daw-accent [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-white"
            />
            {/* Editable dB Input Wrapper */}
            <div className="flex items-center justify-end w-14 gap-0.5 bg-daw-bg/50 rounded px-1 border border-transparent focus-within:border-daw-accent/50 transition-colors">
                <input
                    type="text"
                    value={dbInput}
                    onFocus={() => setIsEditingDb(true)}
                    onBlur={commitDbChange}
                    onKeyDown={handleDbKeyDown}
                    onChange={(e) => setDbInput(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()} // Prevent drag input
                    className="w-full min-w-0 bg-transparent text-right text-[10px] font-mono text-daw-muted focus:text-daw-text outline-none p-0"
                    spellCheck={false}
                />
                <span className="text-[10px] font-mono text-daw-muted select-none">dB</span>
            </div>
        </div>
      </div>

      {/* RIGHT: Waveform (Flex Grow) */}
      <div className="flex-1 relative bg-daw-bg">
        {!isLoaded && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-daw-muted animate-pulse z-10">
            Parsing audio...
          </div>
        )}
        {/* Container for wavesurfer */}
        <div className="absolute inset-0 flex items-center">
            <div ref={waveformContainerRef} className="w-full" />
        </div>
      </div>
    </div>
  );
});
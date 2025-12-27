import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Upload, Play, Pause, Download, Music, Square, Trash2, Plus, ChevronDown, FileAudio, CircleHelp } from 'lucide-react';
import { AudioTrack, PlaybackState } from './types';
import { TrackRow } from './components/TrackRow';
import { MasterMeter } from './components/MasterMeter';
import { GlobalTimeline } from './components/GlobalTimeline';
import { bounceTracks, estimateFileSize } from './services/audioService';
import { HelpModal } from './components/HelpModal';
import WaveSurfer from 'wavesurfer.js';

const App: React.FC = () => {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [playback, setPlayback] = useState<PlaybackState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isExporting: false,
  });
  const [masterVolume, setMasterVolume] = useState(1.0);
  
  // UI State
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  
  // Audio Context for Live Visualization (Mixing Engine)
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const analyserLRef = useRef<AnalyserNode | null>(null);
  const analyserRRef = useRef<AnalyserNode | null>(null);
  
  const [isAudioContextReady, setIsAudioContextReady] = useState(false);
  
  // Bounce Menu State
  const [isBounceMenuOpen, setIsBounceMenuOpen] = useState(false);
  const bounceMenuRef = useRef<HTMLDivElement>(null);

  // Initialize Audio Engine on Mount
  useEffect(() => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const masterGain = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    
    analyserL.fftSize = 256;
    analyserR.fftSize = 256;

    masterGain.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    masterGain.connect(ctx.destination);

    audioContextRef.current = ctx;
    masterGainRef.current = masterGain;
    analyserLRef.current = analyserL;
    analyserRRef.current = analyserR;
    
    setIsAudioContextReady(true);

    return () => {
        ctx.close();
    };
  }, []);

  // Sync Master Volume
  useEffect(() => {
    if (masterGainRef.current) {
        masterGainRef.current.gain.setTargetAtTime(masterVolume, audioContextRef.current?.currentTime || 0, 0.05);
    }
  }, [masterVolume]);
  
  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bounceMenuRef.current && !bounceMenuRef.current.contains(event.target as Node)) {
        setIsBounceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  
  const maxDurationRef = useRef(0);

  // Manual Move Handlers (Swap Logic)
  const moveTrack = useCallback((index: number, direction: 'up' | 'down') => {
    setTracks(items => {
        if (direction === 'up' && index === 0) return items;
        if (direction === 'down' && index === items.length - 1) return items;
        
        const newIndex = direction === 'up' ? index - 1 : index + 1;
        const newItems = [...items];
        
        // Swap
        const temp = newItems[index];
        newItems[index] = newItems[newIndex];
        newItems[newIndex] = temp;
        
        return newItems;
    });
  }, []);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    addFiles(files);
  };

  const addFiles = (files: FileList) => {
    if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume();
    }

    const newTracks: AudioTrack[] = Array.from(files).map((file: File) => ({
      id: uuidv4(),
      name: file.name.replace(/\.[^/.]+$/, ""),
      file,
      url: URL.createObjectURL(file),
      volume: 0.8,
      isMuted: false,
      isSolo: false,
      duration: 0,
    }));

    setTracks((prev) => [...prev, ...newTracks]);
  };

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

    const files = e.dataTransfer.files;
    if (!files) return;
    
    const audioFiles = new DataTransfer();
    (Array.from(files) as File[]).forEach(file => {
        if (file.type.startsWith('audio/')) audioFiles.items.add(file);
    });
    
    if (audioFiles.files.length > 0) {
        addFiles(audioFiles.files);
    }
  };

  const handleVolumeChange = useCallback((id: string, volume: number) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, volume } : t));
  }, []);

  const handleMuteToggle = useCallback((id: string) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t));
  }, []);

  const handleSoloToggle = useCallback((id: string) => {
    setTracks(prev => {
        const toggledTrack = prev.find(t => t.id === id);
        if (!toggledTrack) return prev;
        const newSoloState = !toggledTrack.isSolo;
        const updatedTracks = prev.map(t => t.id === id ? { ...t, isSolo: newSoloState } : t);
        const isAnySolo = updatedTracks.some(t => t.isSolo);
        return updatedTracks.map(t => {
            if (isAnySolo) {
                return { ...t, isMuted: !t.isSolo };
            } else {
                return { ...t, isMuted: false };
            }
        });
    });
  }, []);

  const handleRemoveTrack = useCallback((id: string) => {
    setTracks(prev => prev.filter(t => t.id !== id));
  }, []);

  const handleTrackReady = useCallback((id: string, ws: WaveSurfer, buffer: AudioBuffer) => {
    setTracks(prev => prev.map(t => {
      if (t.id !== id) return t;
      if (buffer.duration > maxDurationRef.current) {
        maxDurationRef.current = buffer.duration;
        setPlayback(p => ({ ...p, duration: buffer.duration }));
      }
      return { ...t, wavesurfer: ws, audioBuffer: buffer, duration: buffer.duration };
    }));
  }, []);

  const togglePlay = () => {
    if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume();
    }

    if (playback.currentTime >= playback.duration && playback.duration > 0) {
      stop();
      setTimeout(() => {
        setPlayback(prev => ({ ...prev, isPlaying: true }));
      }, 50);
      return;
    }
    setPlayback(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  };

  const stop = () => {
    setPlayback(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
    tracks.forEach(t => {
      if (t.wavesurfer) {
        t.wavesurfer.stop();
      }
    });
  };

  const handleExport = async (format: 'wav' | 'mp3') => {
    setIsBounceMenuOpen(false); // Close menu immediately
    if (tracks.length === 0) return;
    setPlayback(prev => ({ ...prev, isExporting: true }));
    try {
      const blob = await bounceTracks(tracks, masterVolume, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mix_bounce.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed", err);
      alert("Failed to export tracks. See console for details.");
    } finally {
      setPlayback(prev => ({ ...prev, isExporting: false }));
    }
  };

  const handleSeek = (time: number) => {
    const safeTime = Math.max(0, Math.min(time, playback.duration));
    const progress = playback.duration > 0 ? safeTime / playback.duration : 0;
    
    setPlayback(prev => ({ ...prev, currentTime: safeTime }));
    tracks.forEach(t => {
      if (t.wavesurfer) {
        t.wavesurfer.seekTo(progress);
      }
    });
  };

  const handleSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      handleSeek(parseFloat(e.target.value));
  }

  useEffect(() => {
    let animationFrameId: number;
    const updateTime = () => {
      if (playback.isPlaying && tracks.length > 0) {
        const activeTrack = tracks.find(t => t.wavesurfer);
        if (activeTrack && activeTrack.wavesurfer) {
          const time = activeTrack.wavesurfer.getCurrentTime();
          setPlayback(prev => ({ ...prev, currentTime: time }));
          if (time >= playback.duration && playback.duration > 0) {
            setPlayback(prev => ({...prev, isPlaying: false }));
          }
        }
      }
      animationFrameId = requestAnimationFrame(updateTime);
    };
    if (playback.isPlaying) {
      updateTime();
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [playback.isPlaying, playback.duration, tracks]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getFooterTime = () => {
      if (!showRemaining) return formatTime(playback.currentTime);
      const remaining = Math.max(0, playback.duration - playback.currentTime);
      return `-${formatTime(remaining)}`;
  };

  const estimateWav = estimateFileSize(playback.duration, 'wav');
  const estimateMp3 = estimateFileSize(playback.duration, 'mp3');

  return (
    <div 
      className="h-screen flex flex-col bg-daw-bg text-daw-text font-sans overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <HelpModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

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
            title="How to Use"
          >
            <CircleHelp size={14} />
            <span className="hidden md:inline">How to use</span>
          </button>
        </div>

        <div className="flex items-center gap-4">
            <div className="flex items-center bg-daw-bg rounded-lg p-1 border border-daw-border">
                <button onClick={stop} className="p-1.5 hover:text-red-400 transition-colors" title="Stop">
                    <Square size={16} fill="currentColor" />
                </button>
                <div className="w-[1px] h-5 bg-daw-border mx-1"></div>
                <button 
                  onClick={togglePlay}
                  className={`p-1.5 rounded-md transition-all ${
                    playback.isPlaying ? 'bg-daw-accent text-white' : 'hover:text-daw-accent'
                  }`}
                >
                    {playback.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                </button>
            </div>

            <div className="font-mono text-lg text-daw-accent w-24 text-center bg-daw-bg py-0.5 px-2 rounded border border-daw-border">
                {formatTime(playback.currentTime)}
            </div>
            
            <div className="relative" ref={bounceMenuRef}>
                <button 
                    onClick={() => !playback.isExporting && tracks.length > 0 && setIsBounceMenuOpen(!isBounceMenuOpen)}
                    disabled={tracks.length === 0 || playback.isExporting}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                        playback.isExporting 
                        ? 'bg-yellow-600 cursor-wait' 
                        : 'bg-indigo-600 hover:bg-indigo-500'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {playback.isExporting ? (
                        'Processing...'
                    ) : (
                        <>
                           <Download size={16} /> 
                           Bounce
                           <ChevronDown size={14} className={`transition-transform duration-200 ${isBounceMenuOpen ? 'rotate-180' : ''}`} />
                        </>
                    )}
                </button>

                {/* Dropdown Menu */}
                {isBounceMenuOpen && !playback.isExporting && (
                    <div className="absolute right-0 top-full mt-2 w-80 bg-daw-panel border border-daw-border rounded-lg shadow-xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="p-2 border-b border-daw-border bg-daw-bg/50">
                            <span className="text-[10px] uppercase font-bold text-daw-muted tracking-wider">Select Format</span>
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
                                        <span className="text-[10px] text-daw-muted whitespace-nowrap">Lossless • 44.1kHz • 16-bit</span>
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

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 overflow-y-auto p-4 relative flex flex-col">
            {tracks.length === 0 ? (
            <div className={`flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-xl m-4 transition-all duration-300 ease-out ${
                isDraggingFile 
                ? 'border-daw-accent bg-daw-accent/10 scale-[1.02] shadow-[0_0_30px_rgba(99,102,241,0.2)]' 
                : 'border-daw-border text-daw-muted hover:border-daw-accent/50'
            }`}>
                <Upload 
                    size={48} 
                    className={`mb-4 transition-all duration-300 ${isDraggingFile ? 'text-daw-accent scale-110' : 'text-daw-accent opacity-50'}`} 
                />
                <h2 className={`text-xl font-bold mb-2 transition-colors ${isDraggingFile ? 'text-daw-accent' : 'text-white'}`}>
                    {isDraggingFile ? 'Drop it like it\'s hot!' : 'Drop Tracks Here'}
                </h2>
                <label className="cursor-pointer bg-daw-panel border border-daw-border px-6 py-2 rounded-lg hover:bg-daw-border transition-colors">
                <span className="font-medium text-sm">Browse</span>
                <input type="file" multiple accept="audio/*" onChange={handleFileUpload} className="hidden" />
                </label>
                <div className="mt-4 text-xs text-daw-muted">
                    Supports WAV, MP3, AAC, OGG
                </div>
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
                    <button onClick={() => setTracks([])} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
                        <Trash2 size={12} /> Clear
                    </button>
                </div>
                
                <div className="space-y-1">
                    {tracks.map((track, index) => (
                        <TrackRow
                            key={track.id}
                            track={track}
                            isPlaying={playback.isPlaying}
                            audioContext={audioContextRef.current}
                            masterNode={masterGainRef.current}
                            onVolumeChange={handleVolumeChange}
                            onMuteToggle={handleMuteToggle}
                            onSoloToggle={handleSoloToggle}
                            onRemove={handleRemoveTrack}
                            onReady={handleTrackReady}
                            isFirst={index === 0}
                            isLast={index === tracks.length - 1}
                            onMoveUp={() => moveTrack(index, 'up')}
                            onMoveDown={() => moveTrack(index, 'down')}
                        />
                    ))}
                </div>

                {/* Add More Tracks Area */}
                <div className="mt-4 border-2 border-dashed border-daw-border rounded-lg p-6 flex flex-col items-center justify-center hover:border-daw-accent/50 hover:bg-daw-panel/30 transition-all cursor-pointer group">
                     <label className="cursor-pointer flex flex-col items-center w-full h-full">
                        <div className="p-3 bg-daw-panel rounded-full mb-2 group-hover:scale-110 transition-transform">
                            <Plus size={24} className="text-daw-muted group-hover:text-daw-accent" />
                        </div>
                        <span className="text-sm font-medium text-daw-muted group-hover:text-daw-text">Add more tracks</span>
                        <input type="file" multiple accept="audio/*" onChange={handleFileUpload} className="hidden" />
                    </label>
                </div>
            </div>
            )}

            {/* Drag Overlay: Changed to fixed to cover viewport regardless of scroll */}
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
                analyserL={analyserLRef.current} 
                analyserR={analyserRRef.current}
                masterVolume={masterVolume}
                onMasterVolumeChange={setMasterVolume}
            />
        </aside>

      </div>

      {tracks.length > 0 && (
        <div className="flex-shrink-0 flex flex-col z-50">
            {/* Global Timeline Visualization */}
            <GlobalTimeline 
                tracks={tracks} 
                duration={playback.duration} 
                currentTime={playback.currentTime}
                onSeek={handleSeek}
            />
            
            <footer className="h-10 bg-daw-panel border-t border-daw-border px-4 flex items-center gap-3">
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
                    max={playback.duration || 100}
                    value={playback.currentTime}
                    onChange={handleSeekInput}
                    className="flex-1 h-1.5 bg-daw-bg rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-daw-accent [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-125 transition-all"
                />
                <span className="text-xs font-mono text-daw-muted">{formatTime(playback.duration)}</span>
            </footer>
        </div>
      )}
    </div>
  );
};

export default App;
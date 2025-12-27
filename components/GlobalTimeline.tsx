import React, { useEffect, useRef, useState } from 'react';
import { AudioTrack } from '../types';

interface GlobalTimelineProps {
  tracks: AudioTrack[];
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
}

export const GlobalTimeline: React.FC<GlobalTimelineProps> = ({
  tracks,
  duration,
  currentTime,
  onSeek
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mergedPeaks, setMergedPeaks] = useState<Float32Array | null>(null);

  // 1. Generate "Sum" Peaks when tracks change
  useEffect(() => {
    if (tracks.length === 0) {
      setMergedPeaks(null);
      return;
    }

    const generatePeaks = () => {
      // Define resolution (e.g., 200 data points usually enough for a small bar, lets do 1000 for detail)
      const width = containerRef.current?.clientWidth || 1000;
      const peaks = new Float32Array(width).fill(0);
      
      // We can't sum full audio buffers in real-time easily without blocking UI.
      // Approximation: Iterate roughly over the buffers and take max amplitude for each pixel bucket.
      
      // Find the track with max duration to normalize time
      const maxDur = Math.max(...tracks.map(t => t.duration || 0));
      if (maxDur === 0) return;

      tracks.forEach(track => {
        if (!track.audioBuffer || track.isMuted) return;
        
        const data = track.audioBuffer.getChannelData(0); // Use Left channel for visual
        const step = Math.ceil(data.length / width);
        const trackDurationRatio = track.duration / maxDur;
        
        // If track is shorter than max, it only occupies a portion
        const activePixels = Math.floor(width * trackDurationRatio);

        for (let i = 0; i < activePixels; i++) {
          const start = i * step;
          // Simple subsampling: take a peak in this window
          let max = 0;
          // Optimization: Check only 10 samples per step to speed up loop
          for (let j = 0; j < 10; j++) {
             const idx = start + Math.floor((j/10)*step);
             if (idx < data.length) {
                 const val = Math.abs(data[idx]);
                 if (val > max) max = val;
             }
          }
          // Add to global peaks (simple summation for visual overlap)
          // We limit to 1.0 later
          peaks[i] = Math.max(peaks[i], max * track.volume); 
        }
      });
      
      setMergedPeaks(peaks);
    };

    // Debounce slightly to avoid heavy calc on drag
    const timeout = setTimeout(generatePeaks, 100);
    return () => clearTimeout(timeout);
  }, [tracks, duration]); // Re-calculate when tracks change

  // 2. Draw Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.clearRect(0, 0, width, height);

    if (!mergedPeaks) return;

    // Draw Waveform
    ctx.fillStyle = '#4f46e5'; // Indigo-600
    ctx.beginPath();
    
    const barWidth = width / mergedPeaks.length;

    for (let i = 0; i < mergedPeaks.length; i++) {
        const amp = Math.min(1, mergedPeaks[i]); // Clamp
        const barHeight = amp * height;
        const y = (height - barHeight) / 2; // Center it
        
        ctx.fillRect(i * barWidth, y, Math.max(1, barWidth - 0.5), barHeight);
    }
  }, [mergedPeaks]);

  // Handle Click / Drag
  const handlePointerDown = (e: React.PointerEvent) => {
    handleSeekFromEvent(e);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.buttons === 1) { // Left click held
        handleSeekFromEvent(e);
    }
  };

  const handleSeekFromEvent = (e: React.PointerEvent) => {
     if (!containerRef.current || duration === 0) return;
     const rect = containerRef.current.getBoundingClientRect();
     const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
     const percent = x / rect.width;
     onSeek(percent * duration);
  };

  return (
    <div 
        ref={containerRef}
        className="h-16 bg-daw-bg border-t border-daw-border relative cursor-crosshair group overflow-hidden"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
    >
        {/* Canvas for Waveform */}
        <canvas 
            ref={canvasRef}
            width={containerRef.current?.clientWidth || 1000}
            height={64}
            className="w-full h-full opacity-60 group-hover:opacity-100 transition-opacity"
        />

        {/* Playhead */}
        {duration > 0 && (
            <div 
                className="absolute top-0 bottom-0 w-[2px] bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)] z-10 pointer-events-none"
                style={{ left: `${(currentTime / duration) * 100}%` }}
            >
                <div className="absolute top-0 -translate-x-1/2 bg-white text-[9px] font-mono text-black px-1 rounded-b opacity-0 group-hover:opacity-100 transition-opacity">
                    {currentTime.toFixed(1)}s
                </div>
            </div>
        )}
        
        {/* Hover overlay hint */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-10 transition-opacity">
             <span className="text-4xl font-bold text-white tracking-widest">TIMELINE</span>
        </div>
    </div>
  );
};
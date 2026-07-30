import React, { useCallback, useEffect, useRef } from 'react';
import { AudioTrack } from '../types';
import type { AudioEngine, TransportState } from '../services/audioEngine';

interface GlobalTimelineProps {
  tracks: AudioTrack[];
  duration: number;
  engine: AudioEngine;
  onSeek: (time: number) => void;
  /** Window currently shown in the track lanes, highlighted here as a navigator. */
  viewStart: number;
  viewDuration: number;
}

const HEIGHT = 64;

/** Pick a gridline spacing that yields a readable number of labels. */
function chooseGridStep(duration: number, width: number): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const minPxPerLine = 70;
  for (const step of candidates) {
    if ((step / duration) * width >= minPxPerLine) return step;
  }
  return candidates[candidates.length - 1];
}

const formatTick = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

/**
 * Session overview: a summed envelope of every audible track plus a time ruler.
 *
 * Peaks come from the per-track envelopes that were already computed in a
 * worker, so this redraws instantly instead of walking raw sample data on the
 * main thread on every change.
 */
export const GlobalTimeline: React.FC<GlobalTimelineProps> = ({
  tracks,
  duration,
  engine,
  onSeek,
  viewStart,
  viewDuration,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, dpr: 1 });
  const lastTimeRef = useRef(0);

  const renderStatic = useCallback(() => {
    const { w, dpr } = sizeRef.current;
    if (w <= 0) return;

    let off = offscreenRef.current;
    if (!off) {
      off = document.createElement('canvas');
      offscreenRef.current = off;
    }
    off.width = Math.max(1, Math.floor(w * dpr));
    off.height = Math.floor(HEIGHT * dpr);

    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, HEIGHT);
    if (duration <= 0) return;

    const columns = Math.max(1, Math.floor(w));
    const mid = HEIGHT / 2;
    const audible = tracks.filter((t) => t.peaks && !t.isMuted && t.duration > 0);

    // Summed envelope: for each column, take the loudest excursion across tracks.
    ctx.fillStyle = '#4f46e5';
    for (let c = 0; c < columns; c++) {
      const tStart = (c / columns) * duration;
      const tEnd = ((c + 1) / columns) * duration;
      let lo = 0;
      let hi = 0;

      for (const track of audible) {
        if (tStart >= track.duration) continue;
        const buckets = track.peaks!.min.length;
        const from = Math.min(buckets - 1, Math.floor((tStart / track.duration) * buckets));
        const to = Math.min(buckets, Math.max(from + 1, Math.ceil((tEnd / track.duration) * buckets)));
        let tLo = 0;
        let tHi = 0;
        for (let b = from; b < to; b++) {
          if (track.peaks!.min[b] < tLo) tLo = track.peaks!.min[b];
          if (track.peaks!.max[b] > tHi) tHi = track.peaks!.max[b];
        }
        lo += tLo * track.volume;
        hi += tHi * track.volume;
      }

      lo = Math.max(-1, lo);
      hi = Math.min(1, hi);
      const y1 = mid - hi * mid;
      const y2 = mid - lo * mid;
      ctx.fillRect(c, y1, 1, Math.max(y2 - y1, 1));
    }

    // Time ruler
    const step = chooseGridStep(duration, w);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    for (let t = step; t < duration; t += step) {
      const x = Math.round((t / duration) * w) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x, 0, 1, HEIGHT);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(formatTick(t), x + 3, 3);
    }
  }, [tracks, duration]);

  const paint = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      const off = offscreenRef.current;
      const { w, dpr } = sizeRef.current;
      if (!canvas || !off || w <= 0) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(off, 0, 0);
      ctx.scale(dpr, dpr);

      if (duration <= 0) return;
      const x = Math.min(1, time / duration) * w;

      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#818cf8';
      ctx.fillRect(0, 0, x, HEIGHT);
      ctx.restore();

      // Dim everything outside the zoomed window and outline what is on screen.
      const zoomed = viewDuration > 0 && viewDuration < duration - 1e-6;
      if (zoomed) {
        const vx = (viewStart / duration) * w;
        const vw = Math.max(2, (viewDuration / duration) * w);
        ctx.fillStyle = 'rgba(18,18,20,0.62)';
        ctx.fillRect(0, 0, vx, HEIGHT);
        ctx.fillRect(vx + vw, 0, w - vx - vw, HEIGHT);
        ctx.strokeStyle = 'rgba(236,236,241,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(vx + 0.5, 0.5, vw - 1, HEIGHT - 1);
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, 0, 2, HEIGHT);
    },
    [duration, viewStart, viewDuration],
  );

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const applySize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      if (w === sizeRef.current.w && dpr === sizeRef.current.dpr) return;
      sizeRef.current = { w, dpr };
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.floor(HEIGHT * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${HEIGHT}px`;
      renderStatic();
      paint(lastTimeRef.current);
    };

    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [renderStatic, paint]);

  useEffect(() => {
    renderStatic();
    paint(lastTimeRef.current);
  }, [renderStatic, paint]);

  useEffect(() => {
    return engine.subscribe((s: TransportState) => {
      lastTimeRef.current = s.time;
      paint(s.time);
    });
  }, [engine, paint]);

  const seekFromEvent = (e: React.PointerEvent) => {
    if (!containerRef.current || duration <= 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    onSeek((x / rect.width) * duration);
  };

  return (
    <div
      ref={containerRef}
      className="bg-daw-bg border-t border-daw-border relative cursor-text group overflow-hidden"
      style={{ height: HEIGHT }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seekFromEvent(e);
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
};

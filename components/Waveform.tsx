import React, { useCallback, useEffect, useRef } from 'react';
import type { PeakData } from '../types';
import type { AudioEngine, TransportState } from '../services/audioEngine';

interface WaveformProps {
  peaks?: PeakData;
  /** This track's own length. */
  duration: number;
  /** Length of the whole session — the shared x-axis for every track. */
  timelineDuration: number;
  engine: AudioEngine;
  color: string;
  progressColor: string;
  height?: number;
  onSeek?: (time: number) => void;
}

/**
 * Waveform + playhead on a plain canvas.
 *
 * Every track is drawn against the *session* duration rather than its own, so
 * rows line up: a 30-second click no longer spans the same width as a 4-minute
 * song, and the playheads cannot disagree.
 *
 * The playhead is driven straight from the engine through an imperative
 * subscription — no React state, no re-render per frame. The static waveform is
 * cached in an offscreen canvas and only redrawn on resize or peak changes.
 */
export const Waveform: React.FC<WaveformProps> = ({
  peaks,
  duration,
  timelineDuration,
  engine,
  color,
  progressColor,
  height = 80,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const lastTimeRef = useRef(0);

  /** Redraw the cached waveform layer. */
  const renderStatic = useCallback(() => {
    const { w, h, dpr } = sizeRef.current;
    if (w === 0 || h === 0) return;

    let off = offscreenRef.current;
    if (!off) {
      off = document.createElement('canvas');
      offscreenRef.current = off;
    }
    off.width = Math.max(1, Math.floor(w * dpr));
    off.height = Math.max(1, Math.floor(h * dpr));

    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (!peaks || timelineDuration <= 0 || duration <= 0) return;

    // The track occupies only its own share of the session timeline.
    const trackWidth = Math.max(1, (duration / timelineDuration) * w);
    const buckets = peaks.min.length;
    const mid = h / 2;

    ctx.fillStyle = color;
    // One column per device pixel keeps the shape crisp on HiDPI screens.
    const columns = Math.max(1, Math.floor(trackWidth * dpr));
    const colW = trackWidth / columns;

    for (let c = 0; c < columns; c++) {
      const from = Math.floor((c / columns) * buckets);
      const to = Math.max(from + 1, Math.floor(((c + 1) / columns) * buckets));
      let lo = 0;
      let hi = 0;
      for (let b = from; b < to && b < buckets; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      const y1 = mid - hi * mid;
      const y2 = mid - lo * mid;
      ctx.fillRect(c * colW, y1, Math.max(colW, 0.7), Math.max(y2 - y1, 1));
    }

    // Faint marker where this track ends, when it is shorter than the session.
    if (duration < timelineDuration - 0.01) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(trackWidth, 0, 1, h);
    }
  }, [peaks, duration, timelineDuration, color]);

  /** Composite the cached waveform + progress tint + playhead. */
  const paint = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      const off = offscreenRef.current;
      const { w, h, dpr } = sizeRef.current;
      if (!canvas || !off || w === 0) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(off, 0, 0);
      ctx.scale(dpr, dpr);

      const progress = timelineDuration > 0 ? Math.min(1, time / timelineDuration) : 0;
      const x = progress * w;

      if (x > 0) {
        // `source-atop` recolours only the waveform pixels already drawn.
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = progressColor;
        ctx.fillRect(0, 0, x, h);
        ctx.restore();
      }

      ctx.fillStyle = 'rgba(236,236,241,0.85)';
      ctx.fillRect(x - 0.5, 0, 1.5, h);
    },
    [timelineDuration, progressColor],
  );

  // Size tracking (DPR-aware, follows container resizes).
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const applySize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = height;
      if (w === sizeRef.current.w && h === sizeRef.current.h && dpr === sizeRef.current.dpr) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      renderStatic();
      paint(lastTimeRef.current);
    };

    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [height, renderStatic, paint]);

  // Redraw the cached layer whenever the shape or scale changes.
  useEffect(() => {
    renderStatic();
    paint(lastTimeRef.current);
  }, [renderStatic, paint]);

  // Follow the transport without re-rendering.
  useEffect(() => {
    return engine.subscribe((s: TransportState) => {
      lastTimeRef.current = s.time;
      paint(s.time);
    });
  }, [engine, paint]);

  const seekFromEvent = (e: React.PointerEvent) => {
    if (!onSeek || timelineDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    onSeek((x / rect.width) * timelineDuration);
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full ${onSeek ? 'cursor-text' : ''}`}
      style={{ height }}
      onPointerDown={(e) => {
        if (!onSeek) return;
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

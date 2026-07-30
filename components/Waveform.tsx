import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PeakData } from '../types';
import type { AudioEngine, TransportState } from '../services/audioEngine';

interface WaveformProps {
  peaks?: PeakData;
  /** Decoded audio, used to draw real samples once zoomed past the peak resolution. */
  buffer?: AudioBuffer;
  /** This track's own length. */
  duration: number;
  /** Left edge of the visible window, in seconds. */
  viewStart: number;
  /** Width of the visible window, in seconds. */
  viewDuration: number;
  engine: AudioEngine;
  color: string;
  progressColor: string;
  height?: number;
  onSeek?: (time: number) => void;
  onZoom?: (factor: number, anchorS: number) => void;
  onPan?: (deltaS: number) => void;
  /** When set, horizontal drags slide the track instead of seeking. */
  draggable?: boolean;
  /** Fired on release with the total drag distance, in seconds. */
  onDragEnd?: (deltaS: number) => void;
}

/** Below this many samples in view, draw from the buffer instead of the peaks. */
const RAW_SAMPLE_BUDGET = 3_000_000;
/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Waveform + playhead on a plain canvas, drawn through a shared view window.
 *
 * Every track renders the same [viewStart, viewStart+viewDuration] span, so
 * rows stay aligned at any zoom level. Zoomed out, the shape comes from the
 * worker-built envelope; zoomed in past that envelope's resolution it is read
 * straight from the AudioBuffer, which is what makes millisecond alignment
 * possible — a stretched envelope would only ever draw a staircase.
 *
 * The playhead is driven straight from the engine through an imperative
 * subscription: no React state, no re-render per frame.
 */
export const Waveform: React.FC<WaveformProps> = ({
  peaks,
  buffer,
  duration,
  viewStart,
  viewDuration,
  engine,
  color,
  progressColor,
  height = 80,
  onSeek,
  onZoom,
  onPan,
  draggable,
  onDragEnd,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const lastTimeRef = useRef(0);

  // Visual offset applied while the track is being dragged. Committed by the
  // parent on release, which arrives back as fresh peaks.
  const [dragDeltaS, setDragDeltaS] = useState(0);
  const pressRef = useRef<{ x: number; moved: boolean } | null>(null);

  // A new envelope means the parent has re-rendered the track at its new
  // position, so the preview offset can be dropped without the shape jumping.
  useEffect(() => {
    setDragDeltaS(0);
  }, [peaks]);

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

    if (viewDuration <= 0 || duration <= 0) return;

    const mid = h / 2;
    const secondsPerPixel = viewDuration / w;
    // Time, in track-local coordinates, shown at a given column.
    const timeAtColumn = (c: number) => viewStart + c * secondsPerPixel - dragDeltaS;

    const visibleSamples = buffer ? viewDuration * buffer.sampleRate : Infinity;
    const useRaw = !!buffer && visibleSamples <= RAW_SAMPLE_BUDGET;
    const channel = useRaw ? buffer!.getChannelData(0) : null;
    const sampleRate = buffer?.sampleRate ?? 0;
    const bucketCount = peaks ? peaks.min.length : 0;

    ctx.fillStyle = color;
    const columns = Math.max(1, Math.floor(w));

    for (let c = 0; c < columns; c++) {
      const t0 = timeAtColumn(c);
      const t1 = timeAtColumn(c + 1);
      if (t1 <= 0 || t0 >= duration) continue; // outside this track

      let lo = 0;
      let hi = 0;

      if (channel) {
        const s0 = Math.max(0, Math.floor(t0 * sampleRate));
        const s1 = Math.min(channel.length, Math.max(s0 + 1, Math.ceil(t1 * sampleRate)));
        for (let i = s0; i < s1; i++) {
          const v = channel[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      } else if (bucketCount > 0) {
        const b0 = Math.max(0, Math.floor((t0 / duration) * bucketCount));
        const b1 = Math.min(bucketCount, Math.max(b0 + 1, Math.ceil((t1 / duration) * bucketCount)));
        for (let b = b0; b < b1; b++) {
          if (peaks!.min[b] < lo) lo = peaks!.min[b];
          if (peaks!.max[b] > hi) hi = peaks!.max[b];
        }
      } else {
        continue;
      }

      const y1 = mid - hi * mid;
      const y2 = mid - lo * mid;
      ctx.fillRect(c, y1, 1, Math.max(y2 - y1, 1));
    }

    // Faint marker where this track ends, when its end is on screen.
    const endX = ((duration + dragDeltaS - viewStart) / viewDuration) * w;
    if (endX > 0 && endX < w) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(endX, 0, 1, h);
    }
  }, [peaks, buffer, duration, viewStart, viewDuration, color, dragDeltaS]);

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

      if (viewDuration <= 0) return;
      const x = ((time - viewStart) / viewDuration) * w;

      if (x > 0) {
        // `source-atop` recolours only the waveform pixels already drawn.
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = progressColor;
        ctx.fillRect(0, 0, Math.min(x, w), h);
        ctx.restore();
      }

      if (x >= 0 && x <= w) {
        ctx.fillStyle = 'rgba(236,236,241,0.85)';
        ctx.fillRect(x - 0.5, 0, 1.5, h);
      }
    },
    [viewStart, viewDuration, progressColor],
  );

  // Size tracking (DPR-aware, follows container resizes).
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const applySize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      if (w === sizeRef.current.w && height === sizeRef.current.h && dpr === sizeRef.current.dpr) return;
      sizeRef.current = { w, h: height, dpr };
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      renderStatic();
      paint(lastTimeRef.current);
    };

    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [height, renderStatic, paint]);

  // Redraw the cached layer whenever shape, view or drag preview changes.
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

  // Ctrl/Cmd + wheel zooms, horizontal wheel pans. Registered natively because
  // preventDefault is needed and React attaches wheel listeners passively.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || (!onZoom && !onPan)) return;

    const onWheel = (e: WheelEvent) => {
      const { w } = sizeRef.current;
      if (w === 0) return;

      // Trackpad pinch arrives as a wheel event with ctrlKey set.
      if ((e.ctrlKey || e.metaKey) && onZoom) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const anchor = viewStart + ((e.clientX - rect.left) / rect.width) * viewDuration;
        onZoom(Math.exp(e.deltaY * 0.002), anchor);
        return;
      }

      if (onPan && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        onPan((e.deltaX / w) * viewDuration);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom, onPan, viewStart, viewDuration]);

  const timeAtEvent = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return viewStart + (x / rect.width) * viewDuration;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressRef.current = { x: e.clientX, moved: false };
    // Draggable rows commit on release, so nothing happens yet.
    if (!draggable && onSeek) onSeek(timeAtEvent(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press) return;
    const dx = e.clientX - press.x;
    if (!press.moved && Math.abs(dx) > DRAG_THRESHOLD_PX) press.moved = true;
    if (!press.moved) return;

    if (draggable) {
      const { w } = sizeRef.current;
      if (w > 0) setDragDeltaS((dx / w) * viewDuration);
    } else if (onSeek) {
      onSeek(timeAtEvent(e.clientX));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || !draggable) return;

    if (press.moved) {
      const { w } = sizeRef.current;
      onDragEnd?.(w > 0 ? ((e.clientX - press.x) / w) * viewDuration : 0);
    } else if (onSeek) {
      // A press that never moved is still a seek.
      onSeek(timeAtEvent(e.clientX));
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full touch-none ${draggable ? 'cursor-ew-resize' : onSeek ? 'cursor-text' : ''}`}
      style={{ height }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <canvas ref={canvasRef} className="block" />
      {draggable && dragDeltaS !== 0 && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-daw-bg/90 border border-amber-500/50 text-[10px] font-mono text-amber-400 pointer-events-none z-30">
          {dragDeltaS > 0 ? '+' : ''}
          {Math.round(dragDeltaS * 1000)} ms
        </div>
      )}
    </div>
  );
};

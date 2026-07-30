import React, { useState, useEffect } from 'react';
import { X, Drum, Minus, Plus, Wand2, Loader2 } from 'lucide-react';
import { ClickSignature, CLICK_BASES } from '../services/clickService';
import type { TempoResult } from '../services/analysisService';

interface ClickTrackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (opts: { signature: ClickSignature; bpm: number; offsetMs: number }) => Promise<void>;
  onDetect: () => Promise<TempoResult>;
  canDetect: boolean;
  defaultDurationS: number;
}

const SIGNATURES: ClickSignature[] = ['1_4', '3_4', '4_4', '6_8'];

const formatDuration = (s: number) => {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

export const ClickTrackModal: React.FC<ClickTrackModalProps> = ({
  isOpen,
  onClose,
  onGenerate,
  onDetect,
  canDetect,
  defaultDurationS,
}) => {
  const [signature, setSignature] = useState<ClickSignature>('4_4');
  const [bpm, setBpm] = useState<number>(120);
  const [offsetMs, setOffsetMs] = useState<number>(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [analysis, setAnalysis] = useState<TempoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape closes the dialog, but not while work is in flight. Registered
  // before the early return so the hook order stays stable.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isGenerating && !isDetecting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isGenerating, isDetecting, onClose]);

  if (!isOpen) return null;

  /** Pick the downbeat that matches a bar length, falling back to beat 1. */
  const downbeatFor = (result: TempoResult, sig: ClickSignature) => {
    const beats = CLICK_BASES[sig].beatsPerBar;
    const match = result.downbeats.find((d) => d.beatsPerBar === beats);
    return (match?.firstDownbeatS ?? result.firstBeatS) * 1000;
  };

  const applySignature = (sig: ClickSignature) => {
    setSignature(sig);
    // Re-derive the downbeat for the new bar length from the same analysis.
    if (analysis) setOffsetMs(Math.round(downbeatFor(analysis, sig)));
  };

  const handleDetect = async () => {
    setError(null);
    setIsDetecting(true);
    try {
      const result = await onDetect();
      setAnalysis(result);
      setBpm(Math.round(result.bpm * 100) / 100);
      setOffsetMs(Math.round(downbeatFor(result, signature)));
    } catch (e: any) {
      setError(e?.message ?? 'Could not analyse the audio');
    } finally {
      setIsDetecting(false);
    }
  };

  const handleGenerate = async () => {
    setError(null);
    if (!(bpm > 0 && bpm < 400)) {
      setError('BPM must be between 1 and 399');
      return;
    }
    setIsGenerating(true);
    try {
      await onGenerate({ signature, bpm, offsetMs });
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Error generating the click');
    } finally {
      setIsGenerating(false);
    }
  };

  const scaleBpm = (factor: number) => {
    const next = Math.round(bpm * factor * 100) / 100;
    if (next > 0 && next < 400) setBpm(next);
  };

  const confidenceLabel = analysis
    ? analysis.confidence > 0.6
      ? { text: 'strong match', cls: 'text-green-400' }
      : analysis.confidence > 0.35
        ? { text: 'fair match', cls: 'text-yellow-400' }
        : { text: 'weak match — check by ear', cls: 'text-orange-400' }
    : null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-daw-panel border border-daw-border rounded-xl shadow-2xl w-full max-w-md flex flex-col relative animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-daw-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-amber-500 to-orange-600 rounded flex items-center justify-center shadow-lg shadow-amber-500/20">
              <Drum size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Add Click Track</h2>
              <p className="text-[11px] text-daw-muted">Generate a metronome locked to the song</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-daw-bg rounded text-daw-muted hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Auto-detect */}
          <button
            onClick={handleDetect}
            disabled={!canDetect || isDetecting}
            title={canDetect ? 'Analyse the loaded tracks' : 'Load a track first'}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-daw-accent/50 bg-daw-accent/10 text-daw-accent text-sm font-medium hover:bg-daw-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isDetecting ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
            {isDetecting ? 'Analysing audio…' : 'Detect tempo from tracks'}
          </button>

          {analysis && confidenceLabel && (
            <div className="text-[11px] bg-daw-bg/50 border border-daw-border rounded px-3 py-2 flex items-center justify-between">
              <span className="text-daw-muted">
                Detected <strong className="text-daw-text font-mono">{analysis.bpm.toFixed(2)}</strong> bpm, first
                downbeat at <strong className="text-daw-text font-mono">{(offsetMs / 1000).toFixed(3)}s</strong>
              </span>
              <span className={confidenceLabel.cls}>{confidenceLabel.text}</span>
            </div>
          )}

          {/* Signature */}
          <div>
            <label className="text-[10px] uppercase font-bold tracking-wider text-daw-muted block mb-2">Time signature</label>
            <div className="grid grid-cols-4 gap-2">
              {SIGNATURES.map((sig) => (
                <button
                  key={sig}
                  onClick={() => applySignature(sig)}
                  className={`py-2 rounded border text-sm font-mono font-bold transition-all ${
                    signature === sig
                      ? 'bg-daw-accent/20 border-daw-accent text-daw-accent'
                      : 'bg-daw-bg border-daw-border text-daw-muted hover:text-white hover:border-daw-accent/40'
                  }`}
                >
                  {CLICK_BASES[sig].label}
                </button>
              ))}
            </div>
          </div>

          {/* BPM */}
          <div>
            <label className="text-[10px] uppercase font-bold tracking-wider text-daw-muted block mb-2">BPM</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBpm((v) => Math.max(1, Math.round((v - 1) * 100) / 100))}
                className="p-2 rounded bg-daw-bg border border-daw-border text-daw-muted hover:text-white hover:border-daw-accent/40"
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                min={1}
                max={399}
                step={0.01}
                value={bpm}
                onChange={(e) => setBpm(parseFloat(e.target.value) || 0)}
                className="flex-1 min-w-0 bg-daw-bg border border-daw-border rounded px-3 py-2 text-center font-mono text-lg text-daw-text outline-none focus:border-daw-accent"
              />
              <button
                onClick={() => setBpm((v) => Math.min(399, Math.round((v + 1) * 100) / 100))}
                className="p-2 rounded bg-daw-bg border border-daw-border text-daw-muted hover:text-white hover:border-daw-accent/40"
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => scaleBpm(0.5)}
                className="flex-1 py-1 rounded text-[11px] font-mono bg-daw-bg border border-daw-border text-daw-muted hover:text-white"
                title="Half time — use if the click is twice as fast as the song"
              >
                ÷2
              </button>
              <button
                onClick={() => scaleBpm(2)}
                className="flex-1 py-1 rounded text-[11px] font-mono bg-daw-bg border border-daw-border text-daw-muted hover:text-white"
                title="Double time — use if the click is half as fast as the song"
              >
                ×2
              </button>
            </div>
            {signature === '6_8' && (
              <p className="text-[10px] text-daw-muted mt-2 leading-snug">
                In 6/8 the pulse is the <strong>eighth note</strong>. Use the eighth-note BPM (dotted-quarter BPM × 3).
              </p>
            )}
          </div>

          {/* Offset */}
          <div>
            <label className="text-[10px] uppercase font-bold tracking-wider text-daw-muted block mb-2">
              First downbeat offset
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step={1}
                value={offsetMs}
                onChange={(e) => setOffsetMs(parseFloat(e.target.value) || 0)}
                className="flex-1 min-w-0 bg-daw-bg border border-daw-border rounded px-3 py-2 text-center font-mono text-sm text-daw-text outline-none focus:border-daw-accent"
              />
              <span className="text-xs text-daw-muted font-mono w-8">ms</span>
            </div>
            <p className="text-[10px] text-daw-muted mt-1.5 leading-snug">
              Where beat 1 lands. You can keep fine-tuning this on the track after adding it.
            </p>
          </div>

          <div className="text-[11px] text-daw-muted bg-daw-bg/50 border border-daw-border rounded px-3 py-2 flex justify-between">
            <span>Length:</span>
            <span className="font-mono text-daw-text">{formatDuration(defaultDurationS)}</span>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{error}</div>
          )}
        </div>

        <div className="p-4 border-t border-daw-border bg-daw-bg/30 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm text-daw-muted hover:text-white" disabled={isGenerating}>
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="px-5 py-2 rounded text-sm font-medium bg-daw-accent hover:bg-daw-accent/80 text-white disabled:opacity-50 disabled:cursor-wait"
          >
            {isGenerating ? 'Generating…' : 'Generate click'}
          </button>
        </div>
      </div>
    </div>
  );
};

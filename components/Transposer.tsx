import React from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export type Note = typeof NOTES[number];

interface TransposerProps {
  pitchSemitones: number;
  referenceKey: Note | null;
  onPitchChange: (semitones: number) => void;
  onReferenceKeyChange: (key: Note | null) => void;
  disabled?: boolean;
}

const MIN_SEMI = -12;
const MAX_SEMI = 12;

const transposeNote = (note: Note, semitones: number): Note => {
  const idx = NOTES.indexOf(note);
  const next = ((idx + semitones) % 12 + 12) % 12;
  return NOTES[next];
};

export const Transposer: React.FC<TransposerProps> = ({
  pitchSemitones,
  referenceKey,
  onPitchChange,
  onReferenceKeyChange,
  disabled,
}) => {
  const clamp = (n: number) => Math.max(MIN_SEMI, Math.min(MAX_SEMI, n));
  const dec = () => onPitchChange(clamp(pitchSemitones - 1));
  const inc = () => onPitchChange(clamp(pitchSemitones + 1));
  const reset = () => onPitchChange(0);

  const transposed = referenceKey ? transposeNote(referenceKey, pitchSemitones) : null;
  const pitchLabel = `${pitchSemitones > 0 ? '+' : ''}${pitchSemitones} st`;
  const isActive = pitchSemitones !== 0;

  return (
    <div
      className={`flex items-center gap-1 bg-daw-bg rounded-lg p-1 border ${
        isActive ? 'border-daw-accent/60' : 'border-daw-border'
      } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
      title="Pitch shift (semitons) — não altera o tempo"
    >
      <div className="flex items-center gap-1 px-1">
        <span className="text-[10px] uppercase tracking-wider text-daw-muted font-bold select-none">
          Key
        </span>
        <select
          value={referenceKey ?? ''}
          onChange={(e) => onReferenceKeyChange((e.target.value || null) as Note | null)}
          className="bg-transparent text-xs font-mono text-daw-text outline-none cursor-pointer hover:text-daw-accent"
          title="Tonalidade atual da música (opcional, só pra mostrar a resultante)"
        >
          <option value="">--</option>
          {NOTES.map((n) => (
            <option key={n} value={n} className="bg-daw-panel">
              {n}
            </option>
          ))}
        </select>
        {transposed && (
          <span className="text-[10px] text-daw-muted select-none">→</span>
        )}
        {transposed && (
          <span className="text-xs font-mono font-bold text-daw-accent select-none min-w-[20px]">
            {transposed}
          </span>
        )}
      </div>

      <div className="w-px h-5 bg-daw-border mx-1" />

      <button
        onClick={dec}
        disabled={pitchSemitones <= MIN_SEMI}
        className="p-1 rounded hover:bg-daw-panel hover:text-white text-daw-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Baixar 1 semitom"
      >
        <Minus size={14} />
      </button>

      <span
        onClick={reset}
        className={`font-mono text-xs w-12 text-center cursor-pointer select-none ${
          isActive ? 'text-daw-accent font-bold' : 'text-daw-muted'
        } hover:text-white`}
        title="Clique pra resetar (0 st)"
      >
        {pitchLabel}
      </span>

      <button
        onClick={inc}
        disabled={pitchSemitones >= MAX_SEMI}
        className="p-1 rounded hover:bg-daw-panel hover:text-white text-daw-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Subir 1 semitom"
      >
        <Plus size={14} />
      </button>

      {isActive && (
        <button
          onClick={reset}
          className="p-1 ml-0.5 rounded hover:bg-daw-panel text-daw-muted hover:text-white transition-colors"
          title="Resetar pitch"
        >
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  );
};

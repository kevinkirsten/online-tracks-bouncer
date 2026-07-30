import React, { useEffect } from 'react';
import { X, Upload, Download, ArrowUpDown, Clock, Music, Sliders, Drum } from 'lucide-react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  // Escape closes the dialog. Registered before the early return so the hook
  // order stays stable.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-daw-panel border border-daw-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col relative animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-daw-border bg-daw-bg/50 sticky top-0 backdrop-blur-md z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Music size={20} className="text-white" />
            </div>
            <div>
                <h2 className="text-xl font-bold text-white">How to Use</h2>
                <p className="text-xs text-daw-muted">Mastering the Online Tracks Bouncer</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-daw-bg rounded-lg text-daw-muted hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-8">
            
            {/* Section 1: Importing */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-daw-accent">
                    <Upload size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">1. Import Your Stems</h3>
                    <p className="text-sm text-daw-muted leading-relaxed">
                        Drag and drop your audio files (WAV, MP3, etc.) anywhere on the screen, or click the "Browse" button.
                        <br/>
                        <span className="text-yellow-500/80 text-xs font-mono mt-1 block">
                            NOTE: All tracks align to the start (0:00). If a track has silence at the beginning, make sure it's included in the file.
                        </span>
                    </p>
                </div>
            </div>

            {/* Section 2: Mixing */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-daw-accent">
                    <Sliders size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">2. Mix & Adjust Levels</h3>
                    <ul className="text-sm text-daw-muted space-y-2 list-disc pl-4">
                        <li>Use the <strong>Volume Slider</strong> for coarse adjustments.</li>
                        <li><strong className="text-daw-text">Double-click the dB value</strong> to type a precise number (e.g., "-3.5").</li>
                        <li>Use <strong>M (Mute)</strong> to silence a track or <strong>S (Solo)</strong> to hear only that track.</li>
                        <li>Adjust the <strong>Master Fader</strong> on the right to control the overall output volume.</li>
                    </ul>
                </div>
            </div>

            {/* Section 3: Organization */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-daw-accent">
                    <ArrowUpDown size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">3. Organize Tracks</h3>
                    <p className="text-sm text-daw-muted leading-relaxed">
                        Use the <ArrowUpDown size={12} className="inline mx-1" /> arrows on the left of each track to change their visual order.
                        This helps keep your session organized (e.g., Drums on top, Vocals on bottom), but does not affect the sound.
                    </p>
                </div>
            </div>

            {/* Section 4: Playback */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-daw-accent">
                    <Clock size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">4. Playback & Navigation</h3>
                    <ul className="text-sm text-daw-muted space-y-2 list-disc pl-4">
                        <li>Click or drag on any <strong>waveform</strong>, or on the bottom <strong>Global Timeline</strong>, to jump to that spot. Every track follows in sample-accurate sync.</li>
                        <li><strong className="text-daw-text">Zoom in horizontally</strong> with <strong>Ctrl/⌘ + scroll</strong> over a waveform (or pinch on a trackpad), or with the zoom buttons at the bottom-right. Zoomed in, the waveform is drawn from the real samples, so you can line things up to the millisecond.</li>
                        <li><strong>Pan</strong> by scrolling sideways, or just click on the Global Timeline — the zoomed window follows you. The lit rectangle down there shows which slice you are looking at.</li>
                        <li>Click the <strong>Timer</strong> in the bottom-left corner to toggle between <em>Elapsed Time</em> and <em>Remaining Time</em>.</li>
                    </ul>
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                        {[
                            ['Space', 'Play / pause'],
                            ['Home', 'Back to start'],
                            ['Enter', 'Stop'],
                            ['← / →', 'Nudge 5 seconds'],
                            ['Shift + ← / →', 'Nudge 1 second'],
                            ['+ / −', 'Zoom in / out'],
                            ['0', 'Fit whole session'],
                        ].map(([key, label]) => (
                            <div key={key} className="flex items-center gap-2">
                                <kbd className="bg-daw-bg border border-daw-border rounded px-1.5 py-0.5 font-mono text-[10px] text-daw-text whitespace-nowrap">{key}</kbd>
                                <span className="text-daw-muted">{label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Section 5: Click & Pitch */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-amber-400">
                    <Drum size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">5. Click Track & Transposing</h3>
                    <ul className="text-sm text-daw-muted space-y-2 list-disc pl-4">
                        <li><strong className="text-daw-text">Add click track</strong> generates a metronome for the whole session. Hit <strong>Detect tempo from tracks</strong> and it analyses your stems to find the BPM and where beat 1 lands.</li>
                        <li>If the detected tempo feels half or double speed, use the <strong className="font-mono">÷2</strong> / <strong className="font-mono">×2</strong> buttons.</li>
                        <li><strong className="text-daw-text">Drag the click track sideways</strong> to slide it onto the beat. Zoom in first and you can see it snap onto the transients; the exact shift in milliseconds shows while you drag. The <strong>offset</strong> buttons and field on the track do the same thing by the number.</li>
                        <li>The <strong>Key / semitone</strong> control at the top transposes everything without changing the tempo. Tracks flagged with <Drum size={11} className="inline mx-0.5" /> are left alone, so your click keeps hitting exactly where it did.</li>
                    </ul>
                </div>
            </div>

            {/* Section 5: Export */}
            <div className="flex gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-daw-bg rounded-lg flex items-center justify-center border border-daw-border text-daw-accent">
                    <Download size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-daw-text mb-1">6. Bounce & Export</h3>
                    <p className="text-sm text-daw-muted leading-relaxed mb-2">
                        Click the <strong>Bounce</strong> button to export your mix. You can choose:
                    </p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-daw-bg p-2 rounded border border-daw-border">
                            <span className="font-bold text-blue-400">WAV (PCM)</span>
                            <p className="text-daw-muted mt-1">Lossless quality. Best for further editing.</p>
                        </div>
                        <div className="bg-daw-bg p-2 rounded border border-daw-border">
                            <span className="font-bold text-green-400">MP3 (320kbps)</span>
                            <p className="text-daw-muted mt-1">Compressed. Best for sharing via WhatsApp/Email.</p>
                        </div>
                    </div>
                    <p className="text-yellow-500/80 text-xs font-mono mt-2">
                        IMPORTANT: The export duration is determined by the <strong>longest track</strong>. Even if shorter tracks end early, the final file will play until the very end.
                    </p>
                </div>
            </div>

        </div>

        {/* Footer */}
        <div className="p-6 border-t border-daw-border bg-daw-bg/30 flex justify-end">
            <button 
                onClick={onClose}
                className="bg-daw-accent hover:bg-daw-accent/80 text-white px-6 py-2 rounded-lg font-medium transition-all"
            >
                Got it, let's mix!
            </button>
        </div>
      </div>
    </div>
  );
};
import React, { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface MasterMeterProps {
  analyserL: AnalyserNode | null;
  analyserR: AnalyserNode | null;
  masterVolume: number;
  onMasterVolumeChange: (vol: number) => void;
}

export const MasterMeter: React.FC<MasterMeterProps> = ({ 
    analyserL, 
    analyserR, 
    masterVolume, 
    onMasterVolumeChange 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();

  // Peak State
  const peaksRef = useRef({ l: 0, r: 0 });

  // Editable Volume State
  const [dbInput, setDbInput] = useState<string>("0.0");
  const [isEditingDb, setIsEditingDb] = useState(false);

  // Helper: Volume <> dB
  const getDbValue = (vol: number) => {
    if (vol <= 0.0001) return '-inf';
    return (20 * Math.log10(vol)).toFixed(1);
  };

  useEffect(() => {
    if (!isEditingDb) {
      setDbInput(getDbValue(masterVolume));
    }
  }, [masterVolume, isEditingDb]);

  const commitDbChange = () => {
    setIsEditingDb(false);
    let valStr = dbInput.trim().toLowerCase();
    let newVol = 0;
    if (valStr === '-inf') {
      newVol = 0;
    } else {
      const parsedDb = parseFloat(valStr);
      if (!isNaN(parsedDb)) {
        const clampedDb = Math.min(parsedDb, 6); 
        newVol = Math.pow(10, clampedDb / 20);
      } else {
        setDbInput(getDbValue(masterVolume));
        return;
      }
    }
    newVol = Math.max(0, Math.min(2, newVol));
    onMasterVolumeChange(newVol);
  };

  const draw = () => {
    if (!analyserL || !analyserR || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const barWidth = (width - 4) / 2;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Draw Background
    ctx.fillStyle = '#1e1e24';
    ctx.fillRect(0, 0, width, height);

    // Draw Grid
    ctx.strokeStyle = '#2a2a35';
    ctx.lineWidth = 1;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
        const y = (height / steps) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Process Left
    const valL = getRMS(analyserL);
    const valR = getRMS(analyserR);

    // Draw Function
    const drawChannel = (val: number, peakObj: {current: number}, xPos: number) => {
        const renderVal = Math.min(val * 4, 1); 
        
        // Peak Logic
        if (renderVal >= peakObj.current) {
            peakObj.current = renderVal;
        } else {
            peakObj.current -= 0.005; // Decay rate
        }
        if (peakObj.current < 0) peakObj.current = 0;

        const barHeight = renderVal * height;
        const peakY = height - (peakObj.current * height);
        const barY = height - barHeight;

        // Gradient
        const gradient = ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#22c55e'); // Green
        gradient.addColorStop(0.6, '#eab308'); // Yellow
        gradient.addColorStop(0.85, '#f97316'); // Orange
        gradient.addColorStop(1, '#ef4444'); // Red

        // Main Bar
        ctx.fillStyle = gradient;
        ctx.fillRect(xPos, barY, barWidth, barHeight);

        // Peak Hold Bar
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(xPos, peakY - 1, barWidth, 2);
    };

    drawChannel(valL, { 
        get current() { return peaksRef.current.l; }, 
        set current(v) { peaksRef.current.l = v; } 
    }, 1);

    drawChannel(valR, { 
        get current() { return peaksRef.current.r; }, 
        set current(v) { peaksRef.current.r = v; } 
    }, 1 + barWidth + 2); // 2px Gap

    requestRef.current = requestAnimationFrame(draw);
  };

  const getRMS = (analyser: AnalyserNode) => {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const x = (dataArray[i] - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / bufferLength);
  };

  useEffect(() => {
    if (analyserL && analyserR) {
        requestRef.current = requestAnimationFrame(draw);
    }
    return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [analyserL, analyserR]);

  return (
    <div className="h-full flex flex-col bg-daw-bg border-l border-daw-border p-2 w-28 select-none">
      
      {/* Title + Info */}
      <div className="flex items-center justify-between mb-2">
         <span className="text-xs font-mono text-daw-muted font-bold">MASTER</span>
         <div className="group relative">
             <Info size={12} className="text-daw-muted hover:text-daw-accent cursor-help" />
             <div className="absolute right-0 top-6 w-48 bg-daw-panel border border-daw-border p-2 rounded shadow-xl text-[10px] text-daw-text z-50 hidden group-hover:block pointer-events-none">
                <p className="mb-1 text-daw-accent font-bold">Final Mix Volume</p>
                <p>This fader controls the volume of the exported file.</p>
                <p className="mt-1 text-daw-muted">Recommended: Keep at 0dB to avoid digital clipping (distortion) in your final bounce.</p>
             </div>
         </div>
      </div>

      {/* Container: Meter + Slider */}
      <div className="flex-1 flex gap-2 mb-2">
         
         {/* Meters */}
         <div className="flex-1 bg-daw-panel border border-daw-border rounded overflow-hidden relative">
            <canvas 
                ref={canvasRef} 
                width={50} 
                height={400} 
                className="w-full h-full"
            />
            {/* dB Scale Overlay */}
            <div className="absolute top-0 left-0 bottom-0 w-full pointer-events-none">
                <div className="flex flex-col justify-between h-full py-1 px-0.5 text-[9px] text-daw-muted/50 font-mono text-center mix-blend-difference">
                    <span>0</span>
                    <span>-6</span>
                    <span>-12</span>
                    <span>-24</span>
                    <span>-inf</span>
                </div>
            </div>
         </div>

         {/* Master Fader - Rotated Horizontal Slider Hack for Cross Browser Consistency */}
         <div className="relative w-8 bg-daw-panel border border-daw-border rounded flex items-center justify-center overflow-hidden">
            {/* 
              Standard range sliders are horizontal. To make a reliable vertical slider:
              1. Make it horizontal with width = container height
              2. Rotate it -90deg
            */}
            <input 
                type="range"
                min="0"
                max="1.5"
                step="0.01"
                value={masterVolume}
                onChange={(e) => onMasterVolumeChange(parseFloat(e.target.value))}
                className="absolute w-[400px] h-8 opacity-0 cursor-pointer origin-center rotate-[-90deg] z-20"
                style={{ width: '100vh', maxWidth: '800px' }} // Ensure it's long enough to cover the vertical space
            />
            
            {/* Visual Track */}
            <div className="absolute inset-x-3 top-2 bottom-2 bg-daw-bg rounded-full pointer-events-none z-0"></div>
            
            {/* Visual Thumb */}
            <div 
                className="absolute left-0 right-0 h-6 bg-gradient-to-t from-gray-700 to-gray-600 border border-daw-border rounded shadow-md pointer-events-none transition-all duration-75 z-10 flex items-center justify-center"
                style={{ bottom: `calc(${(Math.min(masterVolume, 1.5) / 1.5) * 100}% - 12px)` }} 
            >
                <div className="w-full h-[1px] bg-black/50"></div>
                <div className="absolute w-full h-[1px] bg-white/20 translate-y-[1px]"></div>
            </div>
         </div>
      </div>

      {/* L/R Labels */}
      <div className="flex justify-between px-2 text-[10px] text-daw-muted font-mono mb-2">
         <span>L</span>
         <span>R</span>
      </div>

      {/* dB Input */}
      <div className="bg-daw-panel border border-daw-border rounded px-1 py-1 flex items-center justify-center gap-1 cursor-text hover:border-daw-accent/50 transition-colors">
         <input
            type="text"
            value={dbInput}
            onFocus={() => setIsEditingDb(true)}
            onBlur={commitDbChange}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onChange={(e) => setDbInput(e.target.value)}
            className="w-full bg-transparent text-center text-xs font-mono text-daw-accent font-bold outline-none p-0"
         />
         <span className="text-[10px] text-daw-muted">dB</span>
      </div>
    </div>
  );
};
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import { dirtySpots, rubSpots, WASH_H, WASH_SPOTS, WASH_W, type Point } from "./washSpots";

// Wipe-to-confirm wash (REQ §13.121 b): mud spots on the car itself (clipped to the car's
// silhouette), rubbed away with a finger or the mouse. Purely cosmetic — the wash is logged by the
// same `onDone` the old button called.

/** Car silhouette (body + cabin); also the clip path for the mud and the shine. */
const BODY_PATH =
  "M20 122 Q18 98 34 92 L84 84 L116 50 Q124 42 136 42 L206 42 Q218 42 226 50 L254 84 L286 90 Q302 94 302 110 L302 122 Q302 130 294 130 L28 130 Q20 130 20 122 Z";

/** Friendly side-view car in theme tokens (light and dark). `clipId` clips `children` (mud, shine) to the car. */
function WashCar({ clipId, children }: { clipId: string; children?: React.ReactNode }) {
  return (
    <>
      <defs>
        <clipPath id={clipId}>
          <path d={BODY_PATH} />
        </clipPath>
      </defs>
      <ellipse cx="160" cy="152" rx="150" ry="7" className="fill-foreground" opacity="0.12" />
      <path d={BODY_PATH} className="fill-primary" />
      <path d="M96 82 L122 54 L166 54 L166 82 Z" className="fill-background" opacity="0.85" />
      <path d="M174 82 L174 54 L218 54 L244 82 Z" className="fill-background" opacity="0.85" />
      <path d="M170 88 L170 126" className="stroke-primary-foreground" strokeWidth="2" opacity="0.35" />
      <rect x="180" y="96" width="14" height="4" rx="2" className="fill-primary-foreground" opacity="0.6" />
      <rect x="114" y="96" width="14" height="4" rx="2" className="fill-primary-foreground" opacity="0.6" />
      <rect x="288" y="98" width="12" height="9" rx="3" className="fill-maintenance" />
      <rect x="20" y="100" width="7" height="10" rx="2" className="fill-destructive" />
      {[82, 240].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="130" r="22" className="fill-foreground" />
          <circle cx={cx} cy="130" r="10" className="fill-muted" />
        </g>
      ))}
      <g clipPath={`url(#${clipId})`}>{children}</g>
    </>
  );
}

/** One organic mud splat: a blob, a few satellites and a drip. Deterministic per spot index. */
function MudSplat({ x, y, r, level, index }: { x: number; y: number; r: number; level: number; index: number }) {
  const turn = (index * 47) % 360;
  return (
    <g opacity={level} transform={`rotate(${turn} ${x} ${y})`} style={{ transition: "opacity 120ms linear" }}>
      <ellipse cx={x} cy={y} rx={r} ry={r * 0.8} fill="#6b4423" />
      <circle cx={x + r * 0.9} cy={y - r * 0.5} r={r * 0.35} fill="#7a5230" />
      <circle cx={x - r * 0.8} cy={y + r * 0.6} r={r * 0.28} fill="#7a5230" />
      <circle cx={x + r * 0.3} cy={y + r * 1.05} r={r * 0.22} fill="#5c3a1e" />
      <circle cx={x - r * 1.2} cy={y - r * 0.4} r={r * 0.15} fill="#6b4423" />
      <ellipse cx={x - r * 0.3} cy={y - r * 0.25} rx={r * 0.35} ry={r * 0.2} fill="#8d6640" opacity="0.7" />
    </g>
  );
}

export interface WashGameProps {
  /** Called once when every spot is clean, or on "דלג ותעד שטיפה". */
  onDone: () => void;
  /** While true (mutation pending) all input is ignored. */
  disabled?: boolean;
  onBack: () => void;
}

/** Wipe-the-mud confirmation for a car wash: rub every mud spot off the car, or skip. */
export function WashGame({ onDone, disabled = false, onBack }: WashGameProps) {
  const clipId = `wash-clip-${useId().replace(/:/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const [levels, setLevels] = useState<number[]>(() => WASH_SPOTS.map(() => 1));
  const [sponge, setSponge] = useState<Point | null>(null);
  const lastRef = useRef<Point | null>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onDoneRef.current = onDone;
    disabledRef.current = disabled;
  }, [onDone, disabled]);

  const left = dirtySpots(levels);
  useEffect(() => {
    if (left > 0 || doneRef.current || disabledRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }, [left]);

  /** The skip link always tries again: if the save failed, the washed car stays here and this is the retry. */
  function skip() {
    if (disabledRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }

  /** Screen → drawing coordinates through the SVG's own transform (dialog centering, zoom, scaling). */
  function toDrawing(e: React.PointerEvent<SVGSVGElement>): Point | null {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) return null;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function rub(e: React.PointerEvent<SVGSVGElement>) {
    if (doneRef.current || disabledRef.current) return;
    const to = toDrawing(e);
    if (!to) return;
    const from = lastRef.current ?? to;
    lastRef.current = to;
    setSponge(to);
    setLevels((current) => rubSpots(current, WASH_SPOTS, from, to));
  }

  function release() {
    lastRef.current = null;
    setSponge(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-sm text-muted-foreground">{he.carCare.washWipePrompt}</p>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WASH_W} ${WASH_H}`}
        className="mx-auto block h-auto w-full max-w-sm cursor-pointer select-none"
        style={{ touchAction: "none" }}
        data-testid="wash-car"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          lastRef.current = null;
          rub(e);
        }}
        onPointerMove={(e) => {
          if (lastRef.current) rub(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <WashCar clipId={clipId}>
          {WASH_SPOTS.map((spot, i) => (
            <MudSplat key={i} index={i} x={spot.x} y={spot.y} r={spot.r} level={levels[i] ?? 0} />
          ))}
        </WashCar>
        {sponge ? (
          <text x={sponge.x} y={sponge.y} fontSize="26" textAnchor="middle" dominantBaseline="central" className="pointer-events-none">
            🧽
          </text>
        ) : null}
      </svg>
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {tv("carCare.washSpotsLeft", { count: String(left) })}
      </p>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          {he.common.back}
        </Button>
        <Button type="button" variant="ghost" className="min-h-11 text-muted-foreground" disabled={disabled} onClick={skip}>
          {he.carCare.washSkip}
        </Button>
      </div>
    </div>
  );
}

const KEYFRAMES = `
@keyframes wash-shine { from { transform: translateX(-90px) skewX(-20deg); } to { transform: translateX(400px) skewX(-20deg); } }
@keyframes wash-burst { 0% { transform: translate(0,0) scale(0.4); opacity: 1; } 100% { transform: translate(var(--wx), var(--wy)) scale(1); opacity: 0; } }
@keyframes wash-twinkle { 0%,100% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.2); opacity: 1; } }
.wash-shine, .wash-burst, .wash-twinkle { display: none; }
@media (prefers-reduced-motion: no-preference) {
  .wash-shine { display: block; animation: wash-shine 1.2s ease-out 0.2s both; }
  .wash-burst { display: block; animation: wash-burst 1.3s ease-out var(--wd) both; }
  .wash-twinkle { display: block; animation: wash-twinkle 1.2s ease-in-out var(--wd) both; }
}
`;

const BURST_COLORS = ["bg-primary", "bg-available", "bg-maintenance", "bg-destructive", "bg-mine"];
const BURST = Array.from({ length: 18 }, (_, i) => {
  const angle = (i / 18) * Math.PI * 2;
  const dist = 80 + (i % 3) * 26;
  return {
    wx: `${Math.round(Math.cos(angle) * dist)}px`,
    wy: `${Math.round(Math.sin(angle) * dist * 0.7)}px`,
    wd: `${0.15 + (i % 4) * 0.08}s`,
    color: BURST_COLORS[i % BURST_COLORS.length],
  };
});

/** The clean car with a shine sweeping across its body, sparkles and a small burst, then the thank-you. */
export function WashCelebration({ message }: { message: string }) {
  const clipId = `wash-shine-${useId().replace(/:/g, "")}`;
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <style>{KEYFRAMES}</style>
      <div className="relative mx-auto w-full max-w-sm" aria-hidden="true">
        <svg viewBox={`0 0 ${WASH_W} ${WASH_H}`} className="block h-auto w-full">
          <defs>
            <linearGradient id={`${clipId}-g`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.5" stopColor="white" stopOpacity="0.8" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
          </defs>
          <WashCar clipId={clipId}>
            <rect className="wash-shine" x="0" y="30" width="70" height="110" fill={`url(#${clipId}-g)`} />
          </WashCar>
        </svg>
        <div className="pointer-events-none absolute start-1/2 top-1/2 size-0">
          {BURST.map((p, i) => (
            <span
              key={i}
              className={`wash-burst absolute -ms-1 -mt-1 size-2 rounded-full ${p.color}`}
              style={{ "--wx": p.wx, "--wy": p.wy, "--wd": p.wd } as React.CSSProperties}
            />
          ))}
        </div>
        {[
          ["start-[22%] top-[22%]", "0.3s"],
          ["end-[18%] top-[38%]", "0.6s"],
          ["start-[48%] top-[12%]", "0.9s"],
        ].map(([pos, wd]) => (
          <span key={pos} className={`wash-twinkle absolute text-xl ${pos}`} style={{ "--wd": wd } as React.CSSProperties}>
            ✨
          </span>
        ))}
      </div>
      <p className="text-lg font-semibold">{message}</p>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { he, tv } from "@/i18n/he";

import {
  aimFromPointer,
  FUNNEL,
  GROUND_Y,
  hitsFunnel,
  landingY,
  nextFill,
  SAG_PER_SECOND,
  START_AIM,
  streamPath,
  clampAim,
  UREA_H,
  UREA_W,
  wobble,
} from "./ureaStream";

// Urea fill game (FU2, REQ item 219), the wash game's sibling: a little boy pees towards the car's urea funnel;
// the stream starts off the funnel and the member drags to aim it in. Whimsical and simple, a skip button, and
// once the tank is full the boy smiles. Purely cosmetic — the fill is logged by `onDone`.

const KEYFRAMES = `
@keyframes urea-flow { to { stroke-dashoffset: -32; } }
@keyframes urea-pop { 0%,100% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.2); opacity: 1; } }
.urea-flow, .urea-pop { display: none; }
@keyframes urea-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(5px); } }
@keyframes urea-pulse { 0%,100% { opacity: 0.95; } 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: no-preference) {
  .urea-hint { animation: urea-bob 0.9s ease-in-out infinite; }
  .urea-reticle { animation: urea-pulse 1.2s ease-in-out infinite; }
  .urea-flow { display: inline; animation: urea-flow 0.5s linear infinite; }
  .urea-pop { display: inline; transform-box: fill-box; transform-origin: center; animation: urea-pop 1.1s ease-in-out var(--ud) infinite; }
}
`;

const STREAM = "#f2c230";
const SKIN = "#f1c7a1";

interface SceneProps {
  /** Where the stream lands now; null = no stream. */
  landingX: number | null;
  /** Tank level 0..1. */
  fill: number;
  smiling: boolean;
  /** 0..1 — how much has missed so far (the puddle on the ground). */
  puddle: number;
  puddleX: number;
  /** Where the member aims (the draggable reticle); null = none. */
  aimX?: number | null;
  /** The bobbing arrow at the funnel, until the member first touches the scene. */
  showHint?: boolean;
}

/** Gauge geometry: a dark housing (readable on a car of any colour), a white level, ticks every 10%. */
const GAUGE = { x: 282, y: 106, w: 36, h: 52, barX: 286, barY: 110, barW: 11, barH: 44 } as const;

/** The scene shared by the game and its celebration: the car's rear with the funnel and the AdBlue gauge, and the boy. */
function UreaScene({ landingX, fill, smiling, puddle, puddleX, aimX = null, showHint = false }: SceneProps) {
  const hit = landingX !== null && hitsFunnel(landingX);
  return (
    <>
      <style>{KEYFRAMES}</style>
      {/* ground */}
      <line x1="0" y1={GROUND_Y + 1} x2={UREA_W} y2={GROUND_Y + 1} className="stroke-muted-foreground" strokeWidth="1.5" opacity="0.35" />
      {puddle > 0 ? <ellipse cx={puddleX} cy={GROUND_Y + 2} rx={6 + puddle * 22} ry={2 + puddle * 3} fill={STREAM} opacity="0.55" /> : null}

      {/* the car's rear quarter, running off the right edge */}
      <ellipse cx="262" cy={GROUND_Y + 2} rx="70" ry="5" className="fill-foreground" opacity="0.1" />
      <path d="M198 160 L198 122 Q200 110 214 109 L262 107 L276 72 Q280 64 290 64 L322 64 L322 160 Z" className="fill-primary" />
      <path d="M282 104 L292 74 L322 74 L322 104 Z" className="fill-background" opacity="0.85" />
      <rect x="198" y="128" width="9" height="11" rx="2" className="fill-destructive" />
      <circle cx="244" cy="162" r="20" className="fill-foreground" />
      <circle cx="244" cy="162" r="9" className="fill-muted" />

      {/* AdBlue gauge on the door: white level, a tick every 10%, "50%" and "100%" */}
      <rect x={GAUGE.x} y={GAUGE.y} width={GAUGE.w} height={GAUGE.h} rx="4" fill="#1f2630" opacity="0.88" />
      <rect x={GAUGE.barX} y={GAUGE.barY} width={GAUGE.barW} height={GAUGE.barH} rx="1.5" fill="#000" opacity="0.35" />
      <rect x={GAUGE.barX} y={GAUGE.barY + GAUGE.barH * (1 - fill)} width={GAUGE.barW} height={GAUGE.barH * fill} rx="1.5" fill="#ffffff" data-testid="urea-gauge-level" />
      {Array.from({ length: 11 }, (_, i) => {
        const y = GAUGE.barY + GAUGE.barH - (GAUGE.barH * i) / 10;
        const major = i === 5 || i === 10;
        return <line key={i} x1={GAUGE.barX + GAUGE.barW + 1} x2={GAUGE.barX + GAUGE.barW + (major ? 5 : 3)} y1={y} y2={y} stroke="#ffffff" strokeWidth="0.7" opacity="0.85" />;
      })}
      <text x={GAUGE.barX + GAUGE.barW + 6} y={GAUGE.barY + GAUGE.barH / 2 + 1.8} fontSize="5" fill="#ffffff" opacity="0.9">50%</text>
      <text x={GAUGE.barX + GAUGE.barW + 6} y={GAUGE.barY + 1.8} fontSize="5" fill="#ffffff" opacity="0.9">100%</text>

      {/* open filler flap (blue cap) and the funnel */}
      <circle cx="252" cy="104" r="5" fill="#2f74c0" stroke="#ffffff" strokeWidth="1" />
      <path d={`M${FUNNEL.left} ${FUNNEL.y} L${FUNNEL.right} ${FUNNEL.y} L236 100 L228 100 Z`} className="fill-maintenance" />
      <rect x="228" y="99" width="8" height="10" className="fill-maintenance" />
      <ellipse cx={(FUNNEL.left + FUNNEL.right) / 2} cy={FUNNEL.y} rx={(FUNNEL.right - FUNNEL.left) / 2} ry="3.5" className="fill-foreground" opacity="0.35" />
      {smiling ? (
        <g>
          {[0, 1, 2].map((i) => (
            <text key={i} x={220 + i * 12} y={58 - (i % 2) * 8} fontSize="12" className="urea-pop" style={{ ["--ud" as string]: `${i * 0.25}s` }}>✨</text>
          ))}
        </g>
      ) : null}

      {/* the hint arrow over the funnel, gone once the member starts */}
      {showHint ? (
        <g className="urea-hint" data-testid="urea-hint">
          <path d="M232 22 L232 48" className="stroke-foreground" strokeWidth="3" strokeLinecap="round" />
          <path d="M224 41 L232 51 L240 41" fill="none" className="stroke-foreground" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : null}

      {/* the reticle the member drags: where the stream is aimed */}
      {aimX !== null ? (
        <g className="urea-reticle" data-testid="urea-reticle">
          <circle cx={aimX} cy={FUNNEL.y - 2} r="10" fill="none" className="stroke-foreground" strokeWidth="1.6" strokeDasharray="3 2.5" />
          <path d={`M${aimX - 14} ${FUNNEL.y - 2} L${aimX - 6} ${FUNNEL.y - 2} M${aimX + 6} ${FUNNEL.y - 2} L${aimX + 14} ${FUNNEL.y - 2} M${aimX} ${FUNNEL.y - 16} L${aimX} ${FUNNEL.y - 8}`} className="stroke-foreground" strokeWidth="1.6" strokeLinecap="round" />
          <path d={`M${aimX - 22} ${FUNNEL.y - 2} l5 -4 v8 Z M${aimX + 22} ${FUNNEL.y - 2} l-5 -4 v8 Z`} className="fill-foreground" opacity="0.6" />
        </g>
      ) : null}

      {/* the stream */}
      {landingX !== null ? (
        <g>
          <path d={streamPath(landingX)} fill="none" stroke={STREAM} strokeWidth="4" strokeLinecap="round" opacity="0.9" />
          <path d={streamPath(landingX)} fill="none" stroke="#fff6c8" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="6 10" className="urea-flow" opacity="0.9" />
          {hit ? (
            <g fill={STREAM}>
              <circle cx={landingX - 5} cy={FUNNEL.y - 5} r="1.8" />
              <circle cx={landingX + 4} cy={FUNNEL.y - 7} r="1.5" />
            </g>
          ) : (
            <g fill={STREAM}>
              <circle cx={landingX - 7} cy={landingY(landingX) - 4} r="2" />
              <circle cx={landingX + 6} cy={landingY(landingX) - 6} r="1.6" />
              <circle cx={landingX + 1} cy={landingY(landingX) - 9} r="1.3" />
            </g>
          )}
        </g>
      ) : null}

      {/* the boy, facing the car */}
      <g>
        {/* legs and shoes */}
        <rect x="47" y="142" width="9" height="38" rx="4" fill={SKIN} />
        <rect x="61" y="142" width="9" height="38" rx="4" fill={SKIN} />
        <ellipse cx="54" cy="181" rx="9" ry="4" className="fill-foreground" />
        <ellipse cx="68" cy="181" rx="9" ry="4" className="fill-foreground" />
        {/* shorts pulled down a little, shirt */}
        <path d="M43 126 L75 126 L76 146 L42 146 Z" className="fill-booked" />
        <path d="M44 96 Q58 90 72 96 L76 128 L42 128 Z" className="fill-mine" />
        {/* arm reaching forward to aim */}
        <path d="M64 102 Q76 116 74 130" fill="none" stroke={SKIN} strokeWidth="7" strokeLinecap="round" />
        {/* head */}
        <circle cx="58" cy="76" r="18" fill={SKIN} />
        <path d="M40 72 Q42 54 60 56 Q74 56 76 70 Q66 62 56 64 Q48 64 40 72 Z" className="fill-foreground" opacity="0.85" />
        <path d="M58 57 Q60 49 66 52" fill="none" className="stroke-foreground" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
        <circle cx="75" cy="79" r="3" fill={SKIN} />
        {smiling ? (
          <g>
            <path d="M62 74 Q65 70 68 74" fill="none" className="stroke-foreground" strokeWidth="2" strokeLinecap="round" />
            <path d="M60 84 Q67 93 74 84" className="fill-foreground" />
            <path d="M63 86 Q67 90 71 86 Z" fill="#fff" />
            <circle cx="56" cy="84" r="3.5" fill="#f08a8a" opacity="0.6" />
          </g>
        ) : (
          <g>
            <circle cx="66" cy="73" r="2.2" className="fill-foreground" />
            <path d="M63 68 L69 69" className="stroke-foreground" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M64 86 L71 85" className="stroke-foreground" strokeWidth="2" strokeLinecap="round" />
            <ellipse cx="71.5" cy="87" rx="2.6" ry="2" fill="#e57373" />
          </g>
        )}
      </g>
    </>
  );
}

export interface UreaGameProps {
  /** Called on "סיימתי" once the tank is full (R20B10: never on its own, so the note can be written first), or on "דלג ותעד מילוי אוראה". */
  onDone: () => void;
  /** While true (mutation pending) all input is ignored. */
  disabled?: boolean;
  onBack: () => void;
  /** Owner 2026-11-13: an optional note with the fill, as with a tire fill. */
  note: string;
  onNoteChange: (note: string) => void;
}

/** Aim the stream into the funnel until the AdBlue gauge is full, or skip. */
export function UreaGame({ onDone, disabled = false, onBack, note, onNoteChange }: UreaGameProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const aimRef = useRef(START_AIM);
  const holdingRef = useRef(false);
  const fillRef = useRef(0);
  const missRef = useRef(0);
  const puddleXRef = useRef(START_AIM);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  const disabledRef = useRef(disabled);
  const [frame, setFrame] = useState({ landingX: START_AIM, aim: START_AIM, fill: 0, puddle: 0, puddleX: START_AIM, smiling: false });
  const [started, setStarted] = useState(false);
  useEffect(() => {
    onDoneRef.current = onDone;
    disabledRef.current = disabled;
  }, [onDone, disabled]);

  useEffect(() => {
    const motion = typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    const started = last;
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!holdingRef.current) aimRef.current = clampAim(aimRef.current - SAG_PER_SECOND * dt);
      const landingX = aimRef.current + wobble((now - started) / 1000, motion);
      if (!disabledRef.current) fillRef.current = nextFill(fillRef.current, landingX, dt);
      if (!hitsFunnel(landingX)) {
        missRef.current = Math.min(1, missRef.current + dt / 8);
        puddleXRef.current = landingX < (FUNNEL.left + FUNNEL.right) / 2 ? Math.min(landingX, 196) : landingX;
      }
      const full = fillRef.current >= 1;
      setFrame({ landingX, aim: aimRef.current, fill: fillRef.current, puddle: missRef.current, puddleX: puddleXRef.current, smiling: full });
      // R20B10 (QA run 20): a full tank stops the game; the member logs it with "סיימתי" (the note is still open).
      if (full) {
        doneRef.current = true;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  /** The skip link always tries again: if the save failed, the game stays here and this is the retry. */
  function skip() {
    if (disabledRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  }

  function aimAt(e: React.PointerEvent<SVGSVGElement>) {
    if (doneRef.current || disabledRef.current) return;
    const matrix = svgRef.current?.getScreenCTM?.();
    if (!matrix) return;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    aimRef.current = aimFromPointer(point.x);
  }

  const full = frame.fill >= 1;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-sm text-muted-foreground">{he.carCare.ureaPrompt}</p>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${UREA_W} ${UREA_H}`}
        className="mx-auto block h-auto w-full max-w-sm cursor-pointer select-none"
        style={{ touchAction: "none" }}
        data-testid="urea-game"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          holdingRef.current = true;
          setStarted(true);
          aimAt(e);
        }}
        onPointerMove={(e) => {
          if (holdingRef.current) aimAt(e);
        }}
        onPointerUp={() => (holdingRef.current = false)}
        onPointerCancel={() => (holdingRef.current = false)}
      >
        <UreaScene
          landingX={full ? null : frame.landingX}
          aimX={full ? null : frame.aim}
          showHint={!started && !full}
          fill={frame.fill}
          smiling={frame.smiling}
          puddle={frame.puddle}
          puddleX={frame.puddleX}
        />
      </svg>
      <p className="text-center text-xs text-muted-foreground" aria-live="polite">
        {tv("carCare.ureaProgress", { percent: String(Math.round(frame.fill * 100)) })}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        {he.carCare.tireNoteLabel}
        <Textarea value={note} onChange={(event) => onNoteChange(event.target.value)} data-testid="urea-note" />
      </label>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          {he.common.back}
        </Button>
        {full ? (
          <Button type="button" className="min-h-11" disabled={disabled} onClick={() => onDoneRef.current()} data-testid="urea-done">
            {he.carCare.tireDone}
          </Button>
        ) : (
          <Button type="button" variant="ghost" className="min-h-11 text-muted-foreground" disabled={disabled} onClick={skip}>
            {he.carCare.ureaSkip}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The full tank and the smiling boy, then the thank-you. */
export function UreaCelebration({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <svg viewBox={`0 0 ${UREA_W} ${UREA_H}`} className="mx-auto block h-auto w-full max-w-sm" aria-hidden="true">
        <UreaScene landingX={null} fill={1} smiling puddle={0} puddleX={0} />
      </svg>
      <p className="text-lg font-semibold">{message}</p>
    </div>
  );
}

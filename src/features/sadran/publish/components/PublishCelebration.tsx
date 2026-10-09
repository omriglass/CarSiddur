import { Car, Home, MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { he, tv } from "@/i18n/he";

import { carsToShow, peoplePerCar, type CelebrationStats } from "../celebrationStats";

const DISMISS_MS = 5000;
const LANES = 6;
const CONFETTI = 44;
const CONFETTI_COLORS = ["bg-primary", "bg-destructive", "bg-amber-400", "bg-emerald-500", "bg-sky-400", "bg-pink-500"];

// Purely decorative; keyframes live here so no global stylesheet changes. Reduced motion: no animation at all.
const CSS = `
@keyframes pc-drive { from { left: 14%; opacity: 0; } 10% { opacity: 1; } to { left: 80%; opacity: 1; } }
@keyframes pc-confetti { from { transform: translate3d(0,0,0) rotate(0); opacity: 1; } to { transform: translate3d(var(--dx), var(--dy), 0) rotate(var(--rot)); opacity: 0; } }
@keyframes pc-pop { from { transform: scale(.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.pc-car { animation: pc-drive 2.6s ease-in-out both; }
.pc-bit { animation: pc-confetti 1.8s ease-out both; }
.pc-pop { animation: pc-pop .4s ease-out both; }
@media (prefers-reduced-motion: reduce) { .pc-car, .pc-bit, .pc-pop { animation: none !important; } }
`;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function PublishCelebration({ stats, onDone }: { stats: CelebrationStats; onDone: () => void }) {
  const [reduced] = useState(prefersReducedMotion);
  const cars = carsToShow(stats.rides);
  const dots = peoplePerCar(stats);

  useEffect(() => {
    const timer = window.setTimeout(onDone, DISMISS_MS);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [onDone]);

  const confetti = useMemo(() => Array.from({ length: CONFETTI }, (_, i) => {
    const angle = (i / CONFETTI) * Math.PI * 2 + (i % 3) * 0.2;
    const power = 120 + ((i * 53) % 140);
    return {
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      style: { "--dx": `${Math.round(Math.cos(angle) * power)}px`, "--dy": `${Math.round(Math.sin(angle) * power - 40)}px`, "--rot": `${(i * 97) % 720}deg`, animationDelay: `${(i % 5) * 40}ms` } as React.CSSProperties,
    };
  }), []);

  return createPortal(
    <div
      role="status"
      data-testid="publish-celebration"
      className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center gap-6 bg-background/90 p-6 text-center backdrop-blur-sm"
      onClick={onDone}
    >
      <style>{CSS}</style>
      {!reduced ? (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {confetti.map((bit, i) => <span key={i} className={`pc-bit absolute h-2 w-1.5 rounded-sm ${bit.color}`} style={bit.style} />)}
          </div>
          <div aria-hidden dir="ltr" className="relative h-56 w-full max-w-lg text-muted-foreground">
            <Home className="absolute top-1/2 size-7 -translate-y-1/2 text-primary" style={{ left: "2%" }} />
            {[0, 1, 2].map((i) => <MapPin key={i} className="absolute size-6 text-destructive" style={{ left: "88%", top: `${18 + i * 32}%` }} />)}
            {Array.from({ length: cars }, (_, i) => (
              <span
                key={i}
                className="pc-car absolute flex flex-col items-center"
                style={{ top: `${(i % LANES) * (100 / LANES)}%`, animationDelay: `${Math.floor(i / LANES) * 0.8 + (i % LANES) * 0.12}s` }}
              >
                <span className="flex gap-px">{Array.from({ length: dots }, (_, d) => <span key={d} className="size-2 rounded-full bg-mine" />)}</span>
                <Car className="size-8 text-primary" />
              </span>
            ))}
          </div>
        </>
      ) : null}
      <div className="pc-pop space-y-2">
        <h2 className="text-2xl font-bold">{he.sadranPublish.celebrationTitle}</h2>
        {stats.rides > 0 ? <p className="text-base text-muted-foreground">{tv("sadranPublish.celebrationTotals", { rides: String(stats.rides), people: String(stats.people), shared: String(stats.shared) })}</p> : null}
        <span className="sr-only">{he.sadranPublish.celebrationDismiss}</span>
      </div>
    </div>,
    document.body,
  );
}

import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

// Spots around the car name (percent of the parent box), each with its own phase so they never blink together.
const SPECKS = [
  { left: 14, top: 22, size: 2, delay: 0 },
  { left: 84, top: 18, size: 1.5, delay: 1.1 },
  { left: 30, top: 82, size: 1.5, delay: 2.3 },
  { left: 70, top: 78, size: 2, delay: 0.6 },
  { left: 50, top: 10, size: 1.5, delay: 1.8 },
  { left: 6, top: 60, size: 1.5, delay: 2.9 },
  { left: 94, top: 56, size: 1.5, delay: 1.5 },
] as const;

/**
 * WS1 (REQ §13.185 f): faint white specks fading in and out around the name of a freshly washed car.
 * Covers its (relative) parent, never takes taps or drags, no layout shift.
 */
export function CarSparkle({ className }: { className?: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute inset-0", className)}
      title={he.carSparkle.label}
      role="img"
      aria-label={he.carSparkle.label}
      data-testid="car-sparkle"
    >
      {SPECKS.map((s, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute rounded-full bg-white opacity-0 shadow-[0_0_3px_1px_rgb(255_255_255/0.7),0_0_1px_hsl(var(--foreground)/0.35)] animate-car-sparkle motion-reduce:animate-none motion-reduce:opacity-40"
          style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s` }}
        />
      ))}
    </span>
  );
}

import { cn } from "@/lib/utils";

interface AppLogoMarkProps {
  className?: string;
}

/**
 * Small inline car glyph in a tinted `primary/10` chip — the app's logo mark
 * (visual pass, header/nav). A hand-drawn SVG rather than a lucide icon so it
 * reads as a brand mark, not just another nav icon.
 */
export function AppLogoMark({ className }: AppLogoMarkProps) {
  return (
    <span
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10", className)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="size-5 text-primary" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M4 16v-3.2a2 2 0 0 1 .32-1.09l1.7-2.63A2 2 0 0 1 7.7 8h8.6a2 2 0 0 1 1.68 1.08l1.7 2.63c.21.32.32.7.32 1.09V16"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4 16h16v2a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1h-9v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <circle cx="7.5" cy="16" r="1.25" fill="currentColor" />
        <circle cx="16.5" cy="16" r="1.25" fill="currentColor" />
      </svg>
    </span>
  );
}

import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["Heebo", "system-ui", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        available: {
          DEFAULT: "hsl(var(--available))",
          foreground: "hsl(var(--available-foreground))",
        },
        maintenance: {
          DEFAULT: "hsl(var(--maintenance))",
          foreground: "hsl(var(--maintenance-foreground))",
        },
        booked: {
          DEFAULT: "hsl(var(--booked))",
          foreground: "hsl(var(--booked-foreground))",
        },
        rideWork: "hsl(var(--ride-work))",
        rideChildcare: "hsl(var(--ride-childcare))",
        rideHealthcare: "hsl(var(--ride-healthcare))",
        rideErrands: "hsl(var(--ride-errands))",
        rideOther: "hsl(var(--ride-other))",
        rideGreen: "hsl(var(--ride-green))",
        rideYellow: "hsl(var(--ride-yellow))",
        rideRed: "hsl(var(--ride-red))",
        delta: { DEFAULT: "hsl(var(--delta))", soft: "hsl(var(--delta-soft))" },
        mine: "hsl(var(--mine))",
        calendar: { DEFAULT: "hsl(var(--calendar))", foreground: "hsl(var(--calendar-foreground))" },
      },
      backgroundImage: {
        "gradient-hero": "var(--gradient-hero)",
        "gradient-card": "var(--gradient-card)",
      },
      boxShadow: {
        elegant: "var(--shadow-elegant)",
        card: "var(--shadow-card)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // Car report dialog celebration (REQUIREMENTS §6.6, `CarReportDialog.tsx`'s
        // `CelebrationMessage`) — CSS-only, gated behind `motion-safe:`/`motion-reduce:`
        // at the call site rather than a JS `matchMedia` check.
        "car-care-bounce": {
          "0%": { transform: "scale(0.3)", opacity: "0" },
          "50%": { transform: "scale(1.15)" },
          "70%": { transform: "scale(0.95)" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "car-care-pop": {
          "0%, 100%": { transform: "translateY(0) scale(1)", opacity: "0.6" },
          "50%": { transform: "translateY(-8px) scale(1.3)", opacity: "1" },
        },
        // A long-pressed ride became movable (owner 2026-11-01, `WeekGrid.tsx`): one short shake of the whole ride,
        // or of the one edge whose time is changing. Gated behind `motion-safe:` at the call site.
        "ride-armed-shake": {
          "0%, 100%": { transform: "translateX(0)" },
          "20%": { transform: "translateX(-3px) rotate(-1deg)" },
          "40%": { transform: "translateX(3px) rotate(1deg)" },
          "60%": { transform: "translateX(-2px)" },
          "80%": { transform: "translateX(2px)" },
        },
        "ride-edge-shake-top": {
          "0%, 100%": { transform: "translateY(0)" },
          "25%": { transform: "translateY(-3px)" },
          "50%": { transform: "translateY(1px)" },
          "75%": { transform: "translateY(-2px)" },
        },
        "ride-edge-shake-bottom": {
          "0%, 100%": { transform: "translateY(0)" },
          "25%": { transform: "translateY(3px)" },
          "50%": { transform: "translateY(-1px)" },
          "75%": { transform: "translateY(2px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "car-care-bounce": "car-care-bounce 0.5s ease-out",
        "car-care-pop": "car-care-pop 1.2s ease-in-out infinite",
        "ride-armed-shake": "ride-armed-shake 0.38s ease-in-out",
        "ride-edge-shake-top": "ride-edge-shake-top 0.38s ease-in-out",
        "ride-edge-shake-bottom": "ride-edge-shake-bottom 0.38s ease-in-out",
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    // `transition-smooth` utility: `all 0.3s cubic-bezier(0.4,0,0.2,1)` in one
    // class, matching the reference app's `--transition-smooth` token.
    plugin(({ addUtilities }) => {
      addUtilities({ ".transition-smooth": { transition: "var(--transition-smooth)" } });
    }),
  ],
} satisfies Config;

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// ---------------------------------------------------------------------------
// Selector lists for `no-restricted-syntax` (see the hard-rule blocks below).
// ---------------------------------------------------------------------------

// Hebrew block U+0590–U+05FF, as an esquery regex attribute matcher.
const HEBREW = "/[\\u0590-\\u05FF]/";

const HEBREW_MESSAGE =
  "Hebrew belongs in src/i18n/he*.ts (UI) or src/solver/reasons.ts (solver) — CLAUDE.md hard rule 3.";
const HEBREW_SELECTORS = [
  { selector: `Literal[value=${HEBREW}]`, message: HEBREW_MESSAGE },
  { selector: `TemplateElement[value.raw=${HEBREW}]`, message: HEBREW_MESSAGE },
  { selector: `JSXText[value=${HEBREW}]`, message: HEBREW_MESSAGE },
];

const TIME_SELECTORS = [
  {
    selector: "CallExpression[callee.property.name=/^(getHours|getMinutes|getDay|getDate|getMonth|setHours|setMinutes|setDate)$/]",
    message:
      "Use the Asia/Jerusalem helpers in src/lib/time.ts (formatTime, dateKey, weekdayIndex, toJerusalem) instead of raw Date getters/setters — CLAUDE.md hard rule 6.",
  },
  {
    selector: "CallExpression[callee.property.name=/^toLocale/]",
    message: "Use src/lib/time.ts / src/lib/dayLabels.ts instead of toLocale*() — CLAUDE.md hard rule 6.",
  },
];

const SUPABASE_SELECTORS = [
  {
    selector: "CallExpression[callee.object.name='supabase'][callee.property.name=/^(from|rpc)$/]",
    message:
      "Only features/<feature>/api.ts calls supabase.from()/.rpc() (CLAUDE.md folder map); hooks and components go through the feature's api.ts.",
  },
];

const SOLVER_SELECTORS = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "The solver never calls Date.now(); epoch ms come in via SolverInput — CLAUDE.md hard rule 5." },
  { selector: "NewExpression[callee.name='Date']", message: "The solver never constructs Date; it works on epoch ms and slot indexes — CLAUDE.md hard rules 5/6." },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: "The solver is deterministic; no Math.random() — CLAUDE.md hard rule 5." },
];

// Browser globals the solver must never touch (hard rule 5). A *rule*, not a
// syntax selector, so the solver's own `request.window` field is not flagged.
const SOLVER_FORBIDDEN_GLOBALS = ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch"].map(
  (name) => ({ name, message: `The solver touches no DOM/browser API (${name}) — CLAUDE.md hard rule 5.` }),
);

const SOLVER_IMPORT_PATTERNS = {
  patterns: [
    { group: ["react", "react-*", "react/*"], message: "src/solver imports nothing from React — CLAUDE.md hard rule 5." },
    { group: ["@supabase/*", "@/integrations/*"], message: "src/solver imports nothing from Supabase — CLAUDE.md hard rule 5." },
    { group: ["@/i18n", "@/i18n/*"], message: "src/solver imports nothing from src/i18n; Hebrew comes from reasons.ts — CLAUDE.md hard rule 5." },
    { group: ["@/*"], message: "src/solver imports only its own modules (relative paths) — CLAUDE.md hard rule 5." },
  ],
};

const LINT_TEST_FILES = ["**/*.test.{ts,tsx}", "**/__tests__/**", "**/__fixtures__/**"];

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "supabase/functions/_shared/solver.js"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // ---------------------------------------------------------------------------
  // CLAUDE.md hard rules, enforced mechanically (docs/REFACTOR_PLAN_2026-09-11.md B1).
  //
  // Flat config *replaces* a rule's options when a later block matches the
  // same file, so `no-restricted-syntax` is assembled per disjoint file group
  // below from the selector lists above (HEBREW_SELECTORS, TIME_SELECTORS,
  // SUPABASE_SELECTORS, SOLVER_SELECTORS). Order matters: general first, the
  // documented exceptions last.
  // ---------------------------------------------------------------------------

  // General app code: hard rule 3 (Hebrew only in i18n/reasons), hard rule 6
  // (wall-clock math only in src/lib/time.ts), api.ts convention.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: LINT_TEST_FILES,
    rules: { "no-restricted-syntax": ["error", ...HEBREW_SELECTORS, ...TIME_SELECTORS, ...SUPABASE_SELECTORS] },
  },
  // Time helpers may use raw Date getters; everything else still applies.
  {
    files: ["src/lib/time.ts", "src/lib/dayLabels.ts"],
    rules: { "no-restricted-syntax": ["error", ...HEBREW_SELECTORS, ...SUPABASE_SELECTORS] },
  },
  // Only features/<f>/api.ts (and the typed wrapper) talk to Supabase.
  {
    files: ["src/**/api.ts", "src/lib/rpc.ts", "src/integrations/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...HEBREW_SELECTORS, ...TIME_SELECTORS] },
  },
  // Documented Hebrew exceptions (each file carries a comment explaining why):
  // src/i18n (the dictionary), src/sw.ts (its tsconfig cannot import i18n),
  // parseInviteLines.ts (input-recognition synonyms, not UI copy),
  // templates/lib/placeholders.ts (sample data for the template preview),
  // src/components/ui/** (generated by the shadcn CLI, hard rule 8).
  {
    files: [
      "src/i18n/**/*.ts",
      "src/sw.ts",
      "src/components/ui/**/*.tsx",
      "src/features/admin/members/lib/parseInviteLines.ts",
      "src/features/admin/templates/lib/placeholders.ts",
    ],
    rules: { "no-restricted-syntax": ["error", ...TIME_SELECTORS, ...SUPABASE_SELECTORS] },
  },

  // Hard rule 5 — the solver stays pure and deterministic. `reasons.ts` is the
  // one file allowed to hold Hebrew.
  {
    files: ["src/solver/**/*.ts"],
    ignores: LINT_TEST_FILES,
    rules: {
      "no-restricted-imports": ["error", SOLVER_IMPORT_PATTERNS],
      "no-restricted-globals": ["error", ...SOLVER_FORBIDDEN_GLOBALS],
      "no-restricted-syntax": ["error", ...SOLVER_SELECTORS, ...TIME_SELECTORS, ...HEBREW_SELECTORS],
    },
  },
  {
    files: ["src/solver/reasons.ts"],
    rules: {
      "no-restricted-imports": ["error", SOLVER_IMPORT_PATTERNS],
      "no-restricted-globals": ["error", ...SOLVER_FORBIDDEN_GLOBALS],
      "no-restricted-syntax": ["error", ...SOLVER_SELECTORS, ...TIME_SELECTORS],
    },
  },

  {
    files: ["src/sw.ts"],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ["*.config.{ts,js}", "scripts/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["supabase/functions/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Deno edge functions use remote URL imports; not resolvable by the
      // browser tsconfig project used for linting.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);

import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `vitest.config.ts` sets `globals: false`, so Testing Library's automatic
// afterEach-cleanup detection (which looks for a global `afterEach`) never
// fires; without this, DOM from one `it()` in a *.test.tsx file leaks into
// the next, breaking `screen.getByText`-style queries that assume a single
// render per test.
afterEach(() => {
  cleanup();
});

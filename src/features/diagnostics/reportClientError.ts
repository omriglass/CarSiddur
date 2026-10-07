import { currentProfileId, insertClientError } from "./api";
import {
  buildClientErrorRow,
  createReportGate,
  isIgnoredMessage,
  type ClientErrorInput,
} from "./report";

/**
 * Reports a browser error to `client_errors` (E1, docs/ARCHITECTURE.md §12). Fire-and-forget and
 * safe to call from anywhere, including error handlers: it never throws, never toasts, never
 * goes through `lib/rpc.ts` (a failing report must not report itself), dedupes the same message
 * within a minute and sends at most 20 reports per page session.
 */
const gate = createReportGate();

function currentAppVersion(): string {
  return typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown";
}

export function reportClientError(input: ClientErrorInput): void {
  try {
    const message = input.message?.trim();
    if (!message || isIgnoredMessage(message) || !gate.accept(message)) return;
    // `send` only uses api.ts (no toast, no rpc.ts), so a failing report cannot recurse.
    void send({ ...input, message }).catch(() => undefined);
  } catch {
    // Reporting must never throw into the caller.
  }
}

async function send(input: ClientErrorInput): Promise<void> {
  const profileId = await currentProfileId();
  if (!profileId) return;
  await insertClientError(
    buildClientErrorRow(input, {
      pathname: window.location.pathname,
      search: window.location.search,
      appVersion: currentAppVersion(),
      userAgent: navigator.userAgent,
      profileId,
    }),
  );
}

/** Normalises anything thrown/rejected into a report input. */
export function errorToReport(error: unknown, context?: string): ClientErrorInput {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack, context };
  }
  try {
    return { message: typeof error === "string" ? error : JSON.stringify(error) ?? String(error), context };
  } catch {
    return { message: String(error), context };
  }
}

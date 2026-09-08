import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "@/i18n/he";
import { captureInstallPrompt, clearInstallPrompt } from "@/lib/installPrompt";
import { DeviceSetupPrompts } from "./DeviceSetupPrompts";

const mocks = vi.hoisted(() => ({
  supported: true,
  subscribed: false,
  local: null as object | null,
  subscribe: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/push", () => ({
  isPushSupported: () => mocks.supported,
  getCurrentPushSubscription: () => Promise.resolve(mocks.local),
  subscribeToPush: mocks.subscribe,
}));
vi.mock("@/features/auth/usePushSubscriptionStatus", () => ({
  usePushSubscriptionStatus: () => ({ isSubscribed: mocks.subscribed, isLoading: false, refresh: mocks.refresh }),
}));
vi.mock("@/lib/rpc", () => ({ showErrorToast: vi.fn(), showDiagnosticErrorToast: vi.fn() }));

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DeviceSetupPrompts /></QueryClientProvider>);
}

describe("Home device setup suggestions", () => {
  captureInstallPrompt();
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearInstallPrompt();
    mocks.supported = true;
    mocks.subscribed = false;
    mocks.local = null;
    vi.stubGlobal("Notification", { permission: "default" });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Chrome" });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
  });

  it("enables notifications only after a user click and registers the subscription", async () => {
    mount();
    expect(mocks.subscribe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("action.enablePush") }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("persists independent dismissal across remounts", () => {
    const view = mount();
    fireEvent.click(within(screen.getByTestId("install-suggestion")).getByRole("button", { name: t("deviceSetup.later") }));
    expect(screen.queryByTestId("install-suggestion")).not.toBeInTheDocument();
    expect(screen.getByTestId("notification-suggestion")).toBeInTheDocument();
    view.unmount();
    mount();
    expect(screen.queryByTestId("install-suggestion")).not.toBeInTheDocument();
  });

  it("retains an early install event and opens the native prompt only after a click", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
    window.dispatchEvent(event);
    mount();
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t("deviceSetup.install") }));
    await waitFor(() => expect(screen.queryByTestId("install-suggestion")).not.toBeInTheDocument());
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("shows the suggestion again after its snooze expires", () => {
    localStorage.setItem("carshare:device-setup:install", String(Date.now() - 1));
    mount();
    expect(screen.getByTestId("install-suggestion")).toBeInTheDocument();
  });

  it("shows install-first guidance on iOS without asking for notification permission", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "iPhone" });
    mount();
    expect(screen.getByText(t("installHint.ios"))).toBeInTheDocument();
    expect(screen.queryByTestId("notification-suggestion")).not.toBeInTheDocument();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("shows settings guidance for denied permission without a permission button", () => {
    vi.stubGlobal("Notification", { permission: "denied" });
    mount();
    expect(screen.getByText(t("deviceSetup.pushDenied"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("action.enablePush") })).not.toBeInTheDocument();
  });

  it("hides push on unsupported browsers and install in a standalone app", () => {
    mocks.supported = false;
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    mount();
    expect(screen.queryByTestId("install-suggestion")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-suggestion")).not.toBeInTheDocument();
  });

  it("does not confuse another device's subscription with this device", async () => {
    mocks.subscribed = true;
    vi.stubGlobal("Notification", { permission: "granted" });
    mount();
    expect(await screen.findByTestId("notification-suggestion")).toBeInTheDocument();
  });

  it("hides push once the current browser and server both have a subscription", async () => {
    mocks.subscribed = true;
    mocks.local = {};
    vi.stubGlobal("Notification", { permission: "granted" });
    mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(screen.queryByTestId("notification-suggestion")).not.toBeInTheDocument();
  });
});
